import { createAzureSpeechClient } from './clients/azureSpeechClient.js';
import { createFoundryClient } from './clients/foundryClient.js';
import {
  createOpenRouterLlmClient,
  createOpenRouterTtsClient,
} from './clients/openRouterClient.js';
import { ApiError } from './errors/apiError.js';
import {
  getProviderMode,
  getServiceFlags,
  loadProviderSecrets,
  loadProvidersConfig,
  parseEnvBool,
} from './config/loadProviders.js';

const DEFAULT_SPEECH_ENDPOINT = 'https://mock-speech.invalid';
const DEFAULT_SPEECH_AUTH_MODE = 'api-key';
const DEFAULT_SPEECH_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DEFAULT_SPEECH_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 300000;

function envString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function required(value, name) {
  if (value === undefined) {
    throw new Error(`Azure Speech config invalid: missing required env "${name}"`);
  }
  return value;
}

function validateEndpoint(value) {
  const endpoint = required(value, 'AZURE_SPEECH_ENDPOINT');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Azure Speech config invalid: env "AZURE_SPEECH_ENDPOINT" must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'Azure Speech config invalid: env "AZURE_SPEECH_ENDPOINT" must be an HTTPS URL without credentials',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      'Azure Speech config invalid: env "AZURE_SPEECH_ENDPOINT" must not include a query or fragment',
    );
  }
  return endpoint.replace(/\/+$/, '');
}

function validateAuthMode(value) {
  const authMode = required(value, 'AZURE_SPEECH_AUTH_MODE');
  if (authMode !== 'api-key' && authMode !== 'managed-identity') {
    throw new Error(
      'Azure Speech config invalid: env "AZURE_SPEECH_AUTH_MODE" must be "api-key" or "managed-identity"',
    );
  }
  return authMode;
}

function validateTimeout(value) {
  if (value === undefined) return DEFAULT_SPEECH_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error('Azure Speech config invalid: env "AZURE_SPEECH_TIMEOUT_MS" must be an integer');
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Azure Speech config invalid: env "AZURE_SPEECH_TIMEOUT_MS" must be between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function validateOutputFormat(value) {
  const format = required(value, 'AZURE_SPEECH_DEFAULT_FORMAT');
  if (!/^[a-z0-9-]{1,100}$/.test(format)) {
    throw new Error(
      'Azure Speech config invalid: env "AZURE_SPEECH_DEFAULT_FORMAT" has an invalid format',
    );
  }
  return format;
}

function validateRegion(value) {
  if (value === undefined) return undefined;
  if (!/^[a-z0-9-]{2,40}$/.test(value)) {
    throw new Error('Azure Speech config invalid: env "AZURE_SPEECH_REGION" has an invalid format');
  }
  return value;
}

function buildSpeechConfig({ mockDefaults }) {
  const provider = envString(process.env.TTS_PROVIDER) ?? 'azure-speech';
  if (provider === 'openrouter') {
    const read = (name, fallback) =>
      envString(process.env[name]) ?? (mockDefaults ? fallback : undefined);
    const endpoint = envString(process.env.OPENROUTER_BASE_URL) ?? 'https://openrouter.ai/api/v1';
    let parsed;
    try { parsed = new URL(required(endpoint, 'OPENROUTER_BASE_URL')); } catch {
      throw new Error('OpenRouter TTS config invalid: OPENROUTER_BASE_URL must be a valid URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('OpenRouter TTS config invalid: OPENROUTER_BASE_URL must be an HTTPS URL without credentials, query, or fragment');
    }
    const model = required(read('OPENROUTER_TTS_MODEL', 'openai/gpt-4o-mini-tts-2025-12-15'), 'OPENROUTER_TTS_MODEL');
    const voice = required(read('OPENROUTER_TTS_VOICE', 'nova'), 'OPENROUTER_TTS_VOICE');
    const responseFormat = envString(process.env.OPENROUTER_TTS_FORMAT) ?? 'mp3';
    if (!['mp3', 'pcm', 'wav'].includes(responseFormat)) {
      throw new Error('OpenRouter TTS config invalid: OPENROUTER_TTS_FORMAT must be mp3, pcm, or wav');
    }
    const speedValue = envString(process.env.OPENROUTER_TTS_SPEED) ?? '1';
    const speed = Number(speedValue);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new Error('OpenRouter TTS config invalid: OPENROUTER_TTS_SPEED must be from 0.25 to 4');
    }
    return {
      provider,
      endpoint: endpoint.replace(/\/+$/, ''),
      model,
      voice,
      responseFormat,
      speed,
      timeoutMs: validateOpenRouterSpeechTimeout(envString(process.env.OPENROUTER_TTS_TIMEOUT_MS)),
    };
  }
  if (provider !== 'azure-speech') {
    throw new Error('TTS config invalid: TTS_PROVIDER must be "openrouter" or "azure-speech"');
  }
  const read = (name, fallback) =>
    envString(process.env[name]) ?? (mockDefaults ? fallback : undefined);
  return {
    provider: 'azure-speech',
    endpoint: validateEndpoint(read('AZURE_SPEECH_ENDPOINT', DEFAULT_SPEECH_ENDPOINT)),
    authMode: validateAuthMode(read('AZURE_SPEECH_AUTH_MODE', DEFAULT_SPEECH_AUTH_MODE)),
    defaultFormat: validateOutputFormat(
      read('AZURE_SPEECH_DEFAULT_FORMAT', DEFAULT_SPEECH_FORMAT),
    ),
    timeoutMs: validateTimeout(envString(process.env.AZURE_SPEECH_TIMEOUT_MS)),
    region: validateRegion(envString(process.env.AZURE_SPEECH_REGION)),
  };
}

function validateOpenRouterSpeechTimeout(value) {
  if (value === undefined) return DEFAULT_SPEECH_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error('OpenRouter TTS config invalid: OPENROUTER_TTS_TIMEOUT_MS must be an integer');
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`OpenRouter TTS config invalid: OPENROUTER_TTS_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function createSilentWav() {
  const sampleRate = 8000;
  const sampleCount = 640;
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

const MOCK_AUDIO = createSilentWav();

function createMockTtsProvider() {
  return Object.freeze({
    provider: 'mock-tts',
    mode: 'mock',
    async synthesize() {
      return { mediaType: 'audio/wav', audio: MOCK_AUDIO.slice() };
    },
  });
}

function createDisabledTtsProvider(provider = 'azure-speech') {
  return Object.freeze({
    provider,
    async synthesize() {
      throw new ApiError({
        code: 'TTS_FAILED',
        message: 'Patient speech is temporarily unavailable.',
        retryable: true,
        status: 503,
      });
    },
  });
}

function validateMode(mode) {
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error('Provider config invalid: PROVIDER_MODE must be "mock" or "live"');
  }
  return mode;
}

/**
 * Compose one replaceable LLM provider and one replaceable TTS provider.
 * Managed-identity deployments inject narrow async token providers; no identity
 * SDK is coupled to the application composition.
 *
 * @param {{
 *   forceReload?: boolean,
 *   mode?: 'mock' | 'live',
 *   foundryAccessTokenProvider?: (scope: string) => Promise<string>,
 *   speechAccessTokenProvider?: (scope: string) => Promise<string>,
 *   foundryFetchImpl?: typeof fetch,
 *   speechFetchImpl?: typeof fetch,
 *   openRouterFetchImpl?: typeof fetch,
 * }} [opts]
 */
export function createProviderBundle(opts = {}) {
  const envMode = envString(process.env.PROVIDER_MODE)?.toLowerCase();
  const mode = validateMode(opts.mode ?? (envMode === undefined ? getProviderMode() : envMode));
  const foundryConfig = loadProvidersConfig({
    forceReload: opts.forceReload,
    mockDefaults: mode === 'mock',
  });
  const speechConfig = buildSpeechConfig({ mockDefaults: mode === 'mock' });
  const config = { ...foundryConfig, speech: speechConfig };
  const secrets = loadProviderSecrets();
  const services = {
    ...getServiceFlags(),
    speechEnabled: parseEnvBool(process.env.SPEECH_ENABLED, true),
  };

  const llmProvider = config.llm.provider === 'openrouter'
    ? createOpenRouterLlmClient({
        ...config.llm,
        apiKey: secrets.openRouterApiKey,
        mode,
        ...(opts.openRouterFetchImpl ? { fetchImpl: opts.openRouterFetchImpl } : {}),
      })
    : createFoundryClient({
        ...config.llm,
        apiKey: secrets.foundryApiKey,
        accessTokenProvider: opts.foundryAccessTokenProvider,
        mode,
        ...(opts.foundryFetchImpl ? { fetchImpl: opts.foundryFetchImpl } : {}),
      });

  let tts;
  if (mode === 'mock') {
    tts = createMockTtsProvider();
  } else if (speechConfig.provider === 'openrouter') {
    tts = createOpenRouterTtsClient({
      ...speechConfig,
      apiKey: envString(process.env.OPENROUTER_API_KEY),
      mode,
      ...(opts.openRouterFetchImpl ? { fetchImpl: opts.openRouterFetchImpl } : {}),
    });
  } else {
    const speechKey = envString(process.env.AZURE_SPEECH_KEY);
    if (speechConfig.authMode === 'api-key' && !speechKey) {
      throw new Error(
        'Azure Speech config invalid: AZURE_SPEECH_KEY is required for live api-key auth',
      );
    }
    if (
      speechConfig.authMode === 'managed-identity' &&
      typeof opts.speechAccessTokenProvider !== 'function'
    ) {
      throw new Error(
        'Azure Speech config invalid: speechAccessTokenProvider is required for live managed-identity auth',
      );
    }
    tts = createAzureSpeechClient({
      endpoint: speechConfig.endpoint,
      authMode: speechConfig.authMode,
      apiKey: speechKey,
      accessTokenProvider: opts.speechAccessTokenProvider,
      timeoutMs: speechConfig.timeoutMs,
      ...(opts.speechFetchImpl ? { fetchImpl: opts.speechFetchImpl } : {}),
    });
  }

  if (!services.speechEnabled) tts = createDisabledTtsProvider(speechConfig.provider);

  return {
    config,
    mode,
    services,
    publicSummary: {
      mode,
      llm: {
        provider: llmProvider.provider,
        model: llmProvider.model,
        ...(llmProvider.modelVersion ? { modelVersion: llmProvider.modelVersion } : {}),
        enabled: services.llmEnabled,
      },
      speech: {
        provider: tts.provider,
        enabled: services.speechEnabled,
      },
    },
    llmProvider,
    // Compatibility alias retained so existing composition consumers do not change.
    foundry: llmProvider,
    tts,
  };
}
