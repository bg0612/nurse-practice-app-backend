import { ApiError } from '../errors/apiError.js';

const RESPONSE_INTENTS = new Set(['patient-reply', 'feedback']);
const TTS_FORMATS = new Set(['mp3', 'pcm', 'wav']);

function required(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`OpenRouter config invalid: ${label} is required`);
  return normalized;
}

function validateBaseUrl(value) {
  const baseUrl = required(value, 'endpoint');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('OpenRouter config invalid: endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OpenRouter config invalid: endpoint must be an HTTPS URL without credentials, query, or fragment');
  }
  return baseUrl.replace(/\/+$/, '');
}

function validateCommon({ endpoint, apiKey, mode, fetchImpl, timeoutMs }) {
  const baseUrl = validateBaseUrl(endpoint);
  if (!['mock', 'live'].includes(mode)) throw new Error('OpenRouter config invalid: mode must be mock or live');
  if (mode === 'live' && !apiKey?.trim()) throw new Error('OpenRouter config invalid: OPENROUTER_API_KEY is required in live mode');
  if (typeof fetchImpl !== 'function') throw new Error('OpenRouter config invalid: fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('OpenRouter config invalid: timeoutMs must be an integer from 1 to 300000');
  }
  return baseUrl;
}

function providerError({ code, message, status = 502, retryable = true, details }) {
  return new ApiError({ code, message, status, retryable, ...(details ? { details } : {}) });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, failureMessage) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw providerError({
      code: controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      message: failureMessage,
      status: controller.signal.aborted ? 504 : 502,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' };
}

export function createOpenRouterLlmClient({
  endpoint = 'https://openrouter.ai/api/v1',
  apiKey,
  model,
  mode = 'mock',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
}) {
  const baseUrl = validateCommon({ endpoint, apiKey, mode, fetchImpl, timeoutMs });
  const validatedModel = required(model, 'model');

  async function complete({ systemPrompt, messages, maxOutputTokens, temperature, responseFormat, responseIntent }) {
    if (!Array.isArray(messages) || messages.some((item) => !item || typeof item.content !== 'string')) {
      throw providerError({ code: 'PROVIDER_BAD_REQUEST', message: 'OpenRouter completion requires valid messages.', status: 400, retryable: false });
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || !RESPONSE_INTENTS.has(responseIntent)) {
      throw providerError({ code: 'PROVIDER_BAD_REQUEST', message: 'OpenRouter completion request is invalid.', status: 400, retryable: false });
    }
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw providerError({ code: 'PROVIDER_BAD_REQUEST', message: 'temperature must be a number from 0 to 2.', status: 400, retryable: false });
    }
    if (mode === 'mock') {
      return {
        rawText: responseIntent === 'patient-reply'
          ? JSON.stringify({ replyText: "I'm listening. Could you ask me a little more specifically?", revealedFactIds: [] })
          : JSON.stringify({ mock: true, responseIntent }),
        model: validatedModel,
        mock: true,
      };
    }

    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model: validatedModel,
        messages: [
          ...(normalizedSystemPrompt ? [{ role: 'system', content: normalizedSystemPrompt }] : []),
          ...messages,
        ],
        max_tokens: maxOutputTokens,
        ...(temperature === undefined ? {} : { temperature }),
        response_format: responseFormat ?? { type: 'json_object' },
        // DeepSeek V4 enables reasoning by default. Different upstreams can
        // otherwise spend very different portions of max_tokens on hidden
        // reasoning for the same request.
        reasoning: { effort: 'none', exclude: true },
        // OpenRouter may route this model across many upstream providers.
        // Only select endpoints that honour JSON schema and reasoning controls.
        provider: { require_parameters: true },
      }),
    }, timeoutMs, 'OpenRouter request failed. Please try again.');

    let data;
    try { data = await response.json(); } catch { data = undefined; }
    if (!response.ok) {
      throw providerError({
        code: 'PROVIDER_ERROR',
        message: 'OpenRouter returned an error. Please try again.',
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        details: { status: response.status },
      });
    }
    const rawText = data?.choices?.[0]?.message?.content;
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw providerError({ code: 'PROVIDER_BAD_RESPONSE', message: 'OpenRouter returned an unexpected response.' });
    }
    return {
      rawText,
      ...(data?.usage && typeof data.usage === 'object' ? { usage: data.usage } : {}),
      model: data?.model || validatedModel,
      mock: false,
    };
  }

  return Object.freeze({ provider: 'openrouter', endpoint: baseUrl, model: validatedModel, mode, timeoutMs, complete });
}

export function createOpenRouterTtsClient({
  endpoint = 'https://openrouter.ai/api/v1',
  apiKey,
  model,
  voice,
  responseFormat = 'mp3',
  speed = 1,
  mode = 'live',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
}) {
  const baseUrl = validateCommon({ endpoint, apiKey, mode, fetchImpl, timeoutMs });
  const validatedModel = required(model, 'TTS model');
  const validatedVoice = required(voice, 'TTS voice');
  if (!TTS_FORMATS.has(responseFormat)) throw new Error('OpenRouter config invalid: TTS response format must be mp3, pcm, or wav');
  if (typeof speed !== 'number' || speed < 0.25 || speed > 4) throw new Error('OpenRouter config invalid: TTS speed must be from 0.25 to 4');

  async function synthesize(request) {
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    if (!text) throw new Error('OpenRouter speech synthesis text is required');
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ input: text, model: validatedModel, voice: validatedVoice, response_format: responseFormat, speed }),
    }, timeoutMs, 'Patient speech is temporarily unavailable.');
    if (!response?.ok) {
      throw new ApiError({ code: 'TTS_FAILED', message: 'Patient speech is temporarily unavailable.', retryable: true, status: 502 });
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw new ApiError({ code: 'TTS_FAILED', message: 'Patient speech is temporarily unavailable.', retryable: true, status: 502 });
    }
    const fallbackMediaType = responseFormat === 'mp3' ? 'audio/mpeg' : responseFormat === 'pcm' ? 'audio/pcm' : 'audio/wav';
    const contentType = response.headers?.get?.('content-type');
    return { mediaType: contentType?.startsWith('audio/') ? contentType.split(';')[0] : fallbackMediaType, audio };
  }

  return Object.freeze({ provider: 'openrouter', endpoint: baseUrl, model: validatedModel, voice: validatedVoice, responseFormat, mode, timeoutMs, synthesize });
}
