import { ApiError } from '../errors/apiError.js';

export const FOUNDRY_MANAGED_IDENTITY_SCOPE =
  'https://cognitiveservices.azure.com/.default';

const RESPONSE_INTENTS = new Set(['patient-reply', 'feedback']);

function requireNonEmptyString(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`createFoundryClient: ${label} is required`);
  return trimmed;
}

function createCompletionUrl(endpoint) {
  const withoutTrailingSlash = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) return withoutTrailingSlash;
  if (/\/openai\/v1$/i.test(withoutTrailingSlash)) {
    return `${withoutTrailingSlash}/chat/completions`;
  }
  return `${withoutTrailingSlash}/openai/v1/chat/completions`;
}

function validateEndpoint(endpoint) {
  const value = requireNonEmptyString(endpoint, 'endpoint');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('createFoundryClient: endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('createFoundryClient: endpoint must be an HTTPS URL without credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('createFoundryClient: endpoint must not include a query or fragment');
  }
  return value;
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.every(
    (message) =>
      message &&
      typeof message === 'object' &&
      ['system', 'user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' &&
      message.content.trim(),
  );
}

function badRequest(message) {
  return new ApiError({
    code: 'PROVIDER_BAD_REQUEST',
    message,
    retryable: false,
    status: 400,
  });
}

function safeProviderCode(data) {
  const candidate = data?.error?.code ?? data?.code;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Microsoft Foundry OpenAI-v1-compatible transport.
 *
 * Managed identity deliberately uses an injected token provider so this module
 * does not acquire credentials itself or require an Azure SDK. The provider is
 * called with FOUNDRY_MANAGED_IDENTITY_SCOPE and must return a non-empty token.
 */
export function createFoundryClient({
  endpoint,
  deploymentName,
  model,
  modelVersion,
  deploymentType,
  authMode,
  apiKey,
  accessTokenProvider,
  mode = 'mock',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
}) {
  const validatedEndpoint = validateEndpoint(endpoint);
  const validatedDeployment = requireNonEmptyString(deploymentName, 'deploymentName');
  const validatedModel = requireNonEmptyString(model, 'model');
  const validatedVersion = requireNonEmptyString(modelVersion, 'modelVersion');

  if (/^FW-/i.test(validatedDeployment)) {
    throw new Error('createFoundryClient: FW-* deployments are not Direct from Azure');
  }
  if (validatedModel !== 'DeepSeek-V4-Flash' || validatedVersion !== '2026-04-23') {
    throw new Error(
      'createFoundryClient: model must be DeepSeek-V4-Flash version 2026-04-23',
    );
  }
  if (deploymentType !== 'pay-as-you-go') {
    throw new Error('createFoundryClient: deploymentType must be pay-as-you-go');
  }
  if (authMode !== 'api-key' && authMode !== 'managed-identity') {
    throw new Error('createFoundryClient: authMode must be api-key or managed-identity');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('createFoundryClient: timeoutMs must be an integer from 1 to 300000');
  }
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error('createFoundryClient: mode must be mock or live');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createFoundryClient: fetchImpl must be a function');
  }
  if (mode === 'live' && authMode === 'api-key' && !apiKey?.trim()) {
    throw new Error('createFoundryClient: apiKey is required for live api-key auth');
  }
  if (
    mode === 'live' &&
    authMode === 'managed-identity' &&
    typeof accessTokenProvider !== 'function'
  ) {
    throw new Error(
      'createFoundryClient: accessTokenProvider is required for live managed-identity auth',
    );
  }

  const completionUrl = createCompletionUrl(validatedEndpoint);

  async function getAuthHeaders() {
    if (authMode === 'api-key') return { 'api-key': apiKey.trim() };

    let token;
    try {
      token = await accessTokenProvider(FOUNDRY_MANAGED_IDENTITY_SCOPE);
    } catch {
      throw new ApiError({
        code: 'PROVIDER_AUTH_FAILED',
        message: 'Microsoft Foundry authentication failed. Please try again.',
        retryable: true,
        status: 503,
      });
    }
    if (typeof token !== 'string' || !token.trim()) {
      throw new ApiError({
        code: 'PROVIDER_AUTH_FAILED',
        message: 'Microsoft Foundry authentication failed. Please try again.',
        retryable: true,
        status: 503,
      });
    }
    return { Authorization: `Bearer ${token.trim()}` };
  }

  async function complete({ systemPrompt, messages, maxOutputTokens, temperature, responseFormat, responseIntent }) {
    const normalizedSystemPrompt =
      typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    if (!validateMessages(messages)) {
      throw badRequest('Microsoft Foundry completion requires valid messages.');
    }
    if (!normalizedSystemPrompt && messages.length === 0) {
      throw badRequest('Microsoft Foundry completion requires prompt content.');
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw badRequest('maxOutputTokens must be a positive integer.');
    }
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw badRequest('temperature must be a number from 0 to 2.');
    }
    if (!RESPONSE_INTENTS.has(responseIntent)) {
      throw badRequest('responseIntent must be patient-reply or feedback.');
    }

    if (mode === 'mock') {
      return {
        rawText:
          responseIntent === 'patient-reply'
            ? JSON.stringify({
                replyText: "I'm listening. Could you ask me a little more specifically?",
                revealedFactIds: [],
              })
            : JSON.stringify({ mock: true, responseIntent }),
        model: validatedModel,
        modelVersion: validatedVersion,
        deploymentName: validatedDeployment,
        mock: true,
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const authHeaders = await getAuthHeaders();
      response = await fetchImpl(completionUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: validatedDeployment,
          messages: [
            ...(normalizedSystemPrompt
              ? [{ role: 'system', content: normalizedSystemPrompt }]
              : []),
            ...messages,
          ],
          max_output_tokens: maxOutputTokens,
          ...(temperature === undefined ? {} : { temperature }),
          response_format: responseFormat ?? { type: 'json_object' },
        }),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) {
        throw new ApiError({
          code: 'PROVIDER_TIMEOUT',
          message: 'Microsoft Foundry request timed out. Please try again.',
          retryable: true,
          status: 504,
          details: { timeoutMs },
        });
      }
      throw new ApiError({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Microsoft Foundry request failed. Please try again.',
        retryable: true,
        status: 502,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      const providerCode = safeProviderCode(data);
      throw new ApiError({
        code: 'PROVIDER_ERROR',
        message: 'Microsoft Foundry returned an error. Please try again.',
        retryable:
          response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
        status: 502,
        details: {
          status: response.status,
          ...(providerCode ? { providerCode } : {}),
        },
      });
    }

    const rawText = data?.choices?.[0]?.message?.content;
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new ApiError({
        code: 'PROVIDER_BAD_RESPONSE',
        message: 'Microsoft Foundry returned an unexpected response.',
        retryable: true,
        status: 502,
      });
    }

    return {
      rawText,
      ...(data?.usage && typeof data.usage === 'object' ? { usage: data.usage } : {}),
      model: validatedModel,
      modelVersion: validatedVersion,
      deploymentName: validatedDeployment,
      mock: false,
    };
  }

  return {
    provider: 'microsoft-foundry',
    endpoint: validatedEndpoint,
    deploymentName: validatedDeployment,
    model: validatedModel,
    modelVersion: validatedVersion,
    deploymentType,
    authMode,
    mode,
    timeoutMs,
    complete,
  };
}
