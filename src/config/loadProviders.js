// backend/src/config/loadProviders.js
const DEFAULT_PROVIDER = 'openrouter';

/** Fallbacks used only when running in mock mode without a .env file. */
const MOCK_MODE_DEFAULTS = {
  llmModel: 'deepseek/deepseek-v4-flash',
};

/** @type {ProvidersConfig | null} */
let cachedConfig = null;

/**
 * @typedef {object} LlmConfig
 * @property {string} provider
 * @property {string} model
 *
 * @typedef {object} ProvidersConfig
 * @property {LlmConfig} llm
 *
 * @typedef {object} ServiceFlags
 * @property {boolean} llmEnabled
 */

/**
 * @param {string | undefined} value
 * @param {string} label
 * @returns {string}
 */
function requireEnvString(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(`Provider config invalid: missing required env "${label}"`);
  }
  return trimmed;
}

/**
 * @param {string | undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function parseEnvBool(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/**
 * LLM feature toggle from env (default enabled).
 * @returns {ServiceFlags}
 */
export function getServiceFlags() {
  return {
    llmEnabled: parseEnvBool(process.env.LLM_ENABLED, true),
  };
}

/**
 * Build providers config from environment variables only.
 * @param {{ mockDefaults?: boolean }} [opts] When true (mock mode), missing
 *   model env vars fall back to MOCK_MODE_DEFAULTS instead of throwing,
 *   so the app boots with no .env file at all.
 * @returns {ProvidersConfig}
 */
export function buildProvidersConfigFromEnv(opts = {}) {
  const withDefaults = (value, fallback) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
    if (opts.mockDefaults && fallback) return fallback;
    return undefined;
  };

  const llmModel = withDefaults(process.env.LLM_MODEL, MOCK_MODE_DEFAULTS.llmModel);
  const llmProvider = process.env.LLM_PROVIDER?.trim() || DEFAULT_PROVIDER;

  return {
    llm: {
      provider: llmProvider,
      model: requireEnvString(llmModel, 'LLM_MODEL'),
    },
  };
}

/**
 * Load OpenRouter LLM settings from env (cached).
 * @param {{ forceReload?: boolean, mockDefaults?: boolean }} [opts]
 * @returns {ProvidersConfig}
 */
export function loadProvidersConfig(opts = {}) {
  if (cachedConfig && !opts.forceReload) {
    return cachedConfig;
  }

  const config = buildProvidersConfigFromEnv({
    mockDefaults: opts.mockDefaults,
  });
  cachedConfig = config;
  return config;
}

/** Clear cache (tests). */
export function clearProvidersConfigCache() {
  cachedConfig = null;
}

/**
 * @returns {'mock' | 'live'}
 */
export function getProviderMode() {
  const mode = (process.env.PROVIDER_MODE ?? 'mock').trim().toLowerCase();
  return mode === 'live' ? 'live' : 'mock';
}

/**
 * Secrets from environment only — never ship to the client.
 * The LLM authenticates with OPENROUTER_API_KEY.
 * @returns {{ openRouterApiKey: string | undefined }}
 */
export function loadProviderSecrets() {
  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
  };
}
