import { ApiError } from '../errors/apiError.js';

export const AZURE_SPEECH_MANAGED_IDENTITY_SCOPE =
  'https://cognitiveservices.azure.com/.default';

const VOICE_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const OUTPUT_FORMAT_PATTERN = /^[a-z0-9-]{1,100}$/;
const RATE_PATTERN = /^(?:default|x-slow|slow|medium|fast|x-fast|0%|[+-](?:100|[0-9]{1,2})%)$/;
const PITCH_PATTERN = /^(?:default|x-low|low|medium|high|x-high|0%|[+-](?:100|[0-9]{1,2})%|[+-](?:[0-9]|[1-9][0-9]|100)Hz|[+-](?:[0-9]|1[0-2])st)$/;

function requireNonEmptyString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`createAzureSpeechClient: ${label} is required`);
  return normalized;
}

function validateEndpoint(endpoint) {
  const value = requireNonEmptyString(endpoint, 'endpoint');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('createAzureSpeechClient: endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'createAzureSpeechClient: endpoint must be an HTTPS URL without credentials',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error('createAzureSpeechClient: endpoint must not include a query or fragment');
  }
  const base = value.replace(/\/+$/, '');
  return /\/cognitiveservices\/v1$/i.test(base)
    ? base
    : `${base}/cognitiveservices/v1`;
}

export function escapeSsmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateSynthesisRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Azure Speech synthesis request must be an object');
  }
  const text = typeof request.text === 'string' ? request.text : '';
  if (!text.trim()) throw new Error('Azure Speech synthesis text is required');
  if (!VOICE_PATTERN.test(request.voiceId)) throw new Error('Azure Speech voiceId is invalid');
  if (!LANGUAGE_PATTERN.test(request.language)) throw new Error('Azure Speech language is invalid');
  if (!OUTPUT_FORMAT_PATTERN.test(request.outputFormat)) {
    throw new Error('Azure Speech outputFormat is invalid');
  }
  const rate = request.rate ?? 'default';
  const pitch = request.pitch ?? 'default';
  if (!RATE_PATTERN.test(rate)) throw new Error('Azure Speech rate is invalid');
  if (!PITCH_PATTERN.test(pitch)) throw new Error('Azure Speech pitch is invalid');
  return { ...request, text, rate, pitch };
}

function mediaTypeFor(outputFormat, responseContentType) {
  const safeHeader = responseContentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (safeHeader && /^(?:audio\/[a-z0-9.+-]+|application\/octet-stream)$/.test(safeHeader)) {
    return safeHeader;
  }
  if (outputFormat.includes('mp3')) return 'audio/mpeg';
  if (outputFormat.includes('riff') || outputFormat.includes('wav')) return 'audio/wav';
  if (outputFormat.includes('ogg')) return 'audio/ogg';
  if (outputFormat.includes('webm')) return 'audio/webm';
  return 'application/octet-stream';
}

function ttsFailed(status = 502) {
  return new ApiError({
    code: 'TTS_FAILED',
    message: 'Patient speech is temporarily unavailable.',
    retryable: true,
    status,
  });
}

/**
 * Azure Speech implementation of the provider-neutral TtsProvider contract.
 * Managed identity token acquisition is injected so no Azure SDK is required.
 */
export function createAzureSpeechClient({
  endpoint,
  authMode,
  apiKey,
  accessTokenProvider,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
}) {
  const synthesisUrl = validateEndpoint(endpoint);
  if (authMode !== 'api-key' && authMode !== 'managed-identity') {
    throw new Error('createAzureSpeechClient: authMode must be api-key or managed-identity');
  }
  if (authMode === 'api-key' && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new Error('createAzureSpeechClient: apiKey is required for api-key auth');
  }
  if (authMode === 'managed-identity' && typeof accessTokenProvider !== 'function') {
    throw new Error(
      'createAzureSpeechClient: accessTokenProvider is required for managed-identity auth',
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createAzureSpeechClient: fetchImpl must be a function');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('createAzureSpeechClient: timeoutMs must be an integer from 1 to 300000');
  }

  async function authHeaders() {
    if (authMode === 'api-key') {
      return { 'Ocp-Apim-Subscription-Key': apiKey.trim() };
    }
    let token;
    try {
      token = await accessTokenProvider(AZURE_SPEECH_MANAGED_IDENTITY_SCOPE);
    } catch {
      throw ttsFailed(503);
    }
    if (typeof token !== 'string' || !token.trim()) throw ttsFailed(503);
    return { Authorization: `Bearer ${token.trim()}` };
  }

  async function synthesize(rawRequest) {
    let request;
    try {
      request = validateSynthesisRequest(rawRequest);
    } catch {
      throw ttsFailed();
    }

    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeSsmlText(request.language)}">` +
      `<voice name="${escapeSsmlText(request.voiceId)}">` +
      `<prosody rate="${escapeSsmlText(request.rate)}" pitch="${escapeSsmlText(request.pitch)}">` +
      `${escapeSsmlText(request.text)}</prosody></voice></speak>`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(synthesisUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...(await authHeaders()),
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': request.outputFormat,
          'User-Agent': 'nursing-patient-simulator',
        },
        body: ssml,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TTS_FAILED') throw error;
      throw ttsFailed(controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response?.ok) throw ttsFailed();

    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw ttsFailed();
    }
    if (bytes.byteLength === 0) throw ttsFailed();

    return {
      mediaType: mediaTypeFor(
        request.outputFormat,
        response.headers?.get?.('content-type'),
      ),
      audio: bytes,
    };
  }

  return {
    provider: 'azure-speech',
    authMode,
    timeoutMs,
    synthesize,
  };
}
