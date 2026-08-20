// backend/src/providers.js
/**
 * Wire .env LLM settings, toggles, and secrets into the OpenRouter client.
 * Keys never leave the server.
 */
import {
  getProviderMode,
  getServiceFlags,
  loadProviderSecrets,
  loadProvidersConfig,
} from './config/loadProviders.js';
import { createOpenRouterClient } from './clients/openRouterClient.js';

/**
 * @param {{ forceReload?: boolean, mode?: 'mock' | 'live' }} [opts]
 */
export function createProviderBundle(opts = {}) {
  const mode = opts.mode ?? getProviderMode();
  const config = loadProvidersConfig({
    forceReload: opts.forceReload,
    mockDefaults: mode === 'mock',
  });
  const secrets = loadProviderSecrets();
  const services = getServiceFlags();

  const openRouter = createOpenRouterClient({
    model: config.llm.model,
    apiKey: secrets.openRouterApiKey,
    mode,
  });

  return {
    config,
    mode,
    services,
    /** Safe for diagnostics — no secrets */
    publicSummary: {
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        enabled: services.llmEnabled,
      },
      mode,
      llmEnabled: services.llmEnabled,
      hasOpenRouterKey: Boolean(secrets.openRouterApiKey),
    },
    openRouter,
  };
}
