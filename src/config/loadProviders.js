const DEFAULT_PROVIDER = 'microsoft-foundry';
const OPENROUTER_PROVIDER = 'openrouter';
const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';
const APPROVED_MODEL = 'DeepSeek-V4-Flash';
const APPROVED_MODEL_VERSION = '2026-04-23';
const APPROVED_DEPLOYMENT_TYPE = 'pay-as-you-go';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 300000;

/** Fallbacks used only for local/mock execution without a .env file. */
const MOCK_MODE_DEFAULTS = Object.freeze({
  endpoint: 'https://mock-foundry.invalid',
  deploymentName: 'deepseek-v4-flash-mock',
  model: APPROVED_MODEL,
  modelVersion: APPROVED_MODEL_VERSION,
  authMode: 'api-key',
  deploymentType: APPROVED_DEPLOYMENT_TYPE,
});

/** @type {ProvidersConfig | null} */
let cachedConfig = null;

/**
 * @typedef {'api-key' | 'managed-identity'} FoundryAuthMode
 * @typedef {object} LlmConfig
 * @property {'microsoft-foundry'} provider
 * @property {string} endpoint
 * @property {string} deploymentName
 * @property {'DeepSeek-V4-Flash'} model
 * @property {'2026-04-23'} modelVersion
 * @property {FoundryAuthMode} authMode
 * @property {'pay-as-you-go'} deploymentType
 * @property {number} timeoutMs
 * @typedef {object} ProvidersConfig
 * @property {LlmConfig} llm
 * @typedef {object} ServiceFlags
 * @property {boolean} llmEnabled
 */

function envString(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function requireValue(value, label) {
  if (value === undefined) {
    throw new Error(`Provider config invalid: missing required env "${label}"`);
  }
  return value;
}

function requireExact(value, expected, label) {
  const actual = requireValue(value, label);
  if (actual !== expected) {
    throw new Error(`Provider config invalid: env "${label}" must be "${expected}"`);
  }
  return actual;
}

function validateEndpoint(value) {
  const endpoint = requireValue(value, 'FOUNDRY_ENDPOINT');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Provider config invalid: env "FOUNDRY_ENDPOINT" must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'Provider config invalid: env "FOUNDRY_ENDPOINT" must be an HTTPS URL without credentials',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      'Provider config invalid: env "FOUNDRY_ENDPOINT" must not include a query or fragment',
    );
  }
  return endpoint.replace(/\/+$/, '');
}

function validateOpenRouterEndpoint(value) {
  const endpoint = requireValue(value, 'OPENROUTER_BASE_URL');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Provider config invalid: env "OPENROUTER_BASE_URL" must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'Provider config invalid: env "OPENROUTER_BASE_URL" must be an HTTPS URL without credentials',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      'Provider config invalid: env "OPENROUTER_BASE_URL" must not include a query or fragment',
    );
  }
  return endpoint.replace(/\/+$/, '');
}

function validateOpenRouterModel(value) {
  const model = requireValue(value, 'OPENROUTER_LLM_MODEL');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) {
    throw new Error('Provider config invalid: env "OPENROUTER_LLM_MODEL" has an invalid format');
  }
  return model;
}

function validateDeploymentName(value) {
  const deploymentName = requireValue(value, 'FOUNDRY_DEPLOYMENT_NAME');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deploymentName)) {
    throw new Error(
      'Provider config invalid: env "FOUNDRY_DEPLOYMENT_NAME" has an invalid format',
    );
  }
  if (/^FW-/i.test(deploymentName)) {
    throw new Error(
      'Provider config invalid: FOUNDRY_DEPLOYMENT_NAME must be a Direct-from-Azure deployment, not FW-*',
    );
  }
  return deploymentName;
}

function validateAuthMode(value) {
  const authMode = requireValue(value, 'FOUNDRY_AUTH_MODE');
  if (authMode !== 'api-key' && authMode !== 'managed-identity') {
    throw new Error(
      'Provider config invalid: env "FOUNDRY_AUTH_MODE" must be "api-key" or "managed-identity"',
    );
  }
  return authMode;
}

function parseTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error('Provider config invalid: env "FOUNDRY_TIMEOUT_MS" must be an integer');
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Provider config invalid: env "FOUNDRY_TIMEOUT_MS" must be between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function parseEnvBool(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/** @returns {ServiceFlags} */
export function getServiceFlags() {
  return { llmEnabled: parseEnvBool(process.env.LLM_ENABLED, true) };
}

/** Build and validate the approved Phase 1 Foundry configuration. */
export function buildProvidersConfigFromEnv(opts = {}) {
  const read = (key, fallback) =>
    envString(process.env[key]) ?? (opts.mockDefaults ? fallback : undefined);

  const provider = envString(process.env.LLM_PROVIDER) ?? DEFAULT_PROVIDER;
  if (provider !== DEFAULT_PROVIDER && provider !== OPENROUTER_PROVIDER) {
    throw new Error(
      `Provider config invalid: env "LLM_PROVIDER" must be "${DEFAULT_PROVIDER}" or "${OPENROUTER_PROVIDER}"`,
    );
  }

  if (provider === OPENROUTER_PROVIDER) {
    return {
      llm: {
        provider: OPENROUTER_PROVIDER,
        endpoint: validateOpenRouterEndpoint(
          envString(process.env.OPENROUTER_BASE_URL) ?? OPENROUTER_DEFAULT_ENDPOINT,
        ),
        model: validateOpenRouterModel(
          read('OPENROUTER_LLM_MODEL', 'openai/gpt-4o-mini'),
        ),
        timeoutMs: parseOpenRouterTimeoutMs(envString(process.env.OPENROUTER_TIMEOUT_MS)),
      },
    };
  }

  return {
    llm: {
      provider: DEFAULT_PROVIDER,
      endpoint: validateEndpoint(read('FOUNDRY_ENDPOINT', MOCK_MODE_DEFAULTS.endpoint)),
      deploymentName: validateDeploymentName(
        read('FOUNDRY_DEPLOYMENT_NAME', MOCK_MODE_DEFAULTS.deploymentName),
      ),
      model: requireExact(
        read('FOUNDRY_MODEL', MOCK_MODE_DEFAULTS.model),
        APPROVED_MODEL,
        'FOUNDRY_MODEL',
      ),
      modelVersion: requireExact(
        read('FOUNDRY_MODEL_VERSION', MOCK_MODE_DEFAULTS.modelVersion),
        APPROVED_MODEL_VERSION,
        'FOUNDRY_MODEL_VERSION',
      ),
      authMode: validateAuthMode(read('FOUNDRY_AUTH_MODE', MOCK_MODE_DEFAULTS.authMode)),
      deploymentType: requireExact(
        read('FOUNDRY_DEPLOYMENT_TYPE', MOCK_MODE_DEFAULTS.deploymentType),
        APPROVED_DEPLOYMENT_TYPE,
        'FOUNDRY_DEPLOYMENT_TYPE',
      ),
      timeoutMs: parseTimeoutMs(envString(process.env.FOUNDRY_TIMEOUT_MS)),
    },
  };
}

function parseOpenRouterTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error('Provider config invalid: env "OPENROUTER_TIMEOUT_MS" must be an integer');
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Provider config invalid: env "OPENROUTER_TIMEOUT_MS" must be between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function loadProvidersConfig(opts = {}) {
  if (cachedConfig && !opts.forceReload) return cachedConfig;
  cachedConfig = buildProvidersConfigFromEnv({ mockDefaults: opts.mockDefaults });
  return cachedConfig;
}

export function clearProvidersConfigCache() {
  cachedConfig = null;
}

export function getProviderMode() {
  const mode = (process.env.PROVIDER_MODE ?? 'mock').trim().toLowerCase();
  return mode === 'live' ? 'live' : 'mock';
}

/** Secrets remain separate from safe provider metadata. */
export function loadProviderSecrets() {
  if ((envString(process.env.LLM_PROVIDER) ?? DEFAULT_PROVIDER) === OPENROUTER_PROVIDER) {
    return { openRouterApiKey: envString(process.env.OPENROUTER_API_KEY) };
  }
  return { foundryApiKey: envString(process.env.FOUNDRY_API_KEY) };
}

export const FOUNDRY_DEFAULTS = Object.freeze({
  provider: DEFAULT_PROVIDER,
  model: APPROVED_MODEL,
  modelVersion: APPROVED_MODEL_VERSION,
  deploymentType: APPROVED_DEPLOYMENT_TYPE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
