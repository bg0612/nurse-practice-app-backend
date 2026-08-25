import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearProvidersConfigCache } from '../src/config/loadProviders.js';
import { createProviderBundle } from '../src/providers.js';

const ENV_KEYS = [
  'PROVIDER_MODE', 'LLM_PROVIDER', 'TTS_PROVIDER', 'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL', 'OPENROUTER_LLM_MODEL', 'OPENROUTER_TIMEOUT_MS',
  'OPENROUTER_TTS_MODEL', 'OPENROUTER_TTS_VOICE', 'OPENROUTER_TTS_FORMAT',
  'OPENROUTER_TTS_SPEED', 'OPENROUTER_TTS_TIMEOUT_MS',
];

afterEach(() => {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  clearProvidersConfigCache();
});

describe('OpenRouter provider composition', () => {
  it('selects OpenRouter for LLM and TTS behind the existing contracts', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.TTS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_LLM_MODEL = 'openai/gpt-4o-mini';
    process.env.OPENROUTER_TTS_MODEL = 'openai/gpt-4o-mini-tts-2025-12-15';
    process.env.OPENROUTER_TTS_VOICE = 'nova';
    process.env.OPENROUTER_TTS_FORMAT = 'mp3';

    const bundle = createProviderBundle({
      mode: 'live',
      forceReload: true,
      openRouterFetchImpl: async () => ({ ok: true }),
    });

    assert.equal(bundle.llmProvider.provider, 'openrouter');
    assert.equal(bundle.tts.provider, 'openrouter');
    assert.equal(typeof bundle.llmProvider.complete, 'function');
    assert.equal(typeof bundle.tts.synthesize, 'function');
    assert.deepEqual(bundle.publicSummary, {
      mode: 'live',
      llm: { provider: 'openrouter', model: 'openai/gpt-4o-mini', enabled: true },
      speech: { provider: 'openrouter', enabled: true },
    });
  });
});
