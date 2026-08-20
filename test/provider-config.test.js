// backend/test/provider-config.test.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createOpenRouterClient } from '../src/clients/openRouterClient.js';
import {
  buildProvidersConfigFromEnv,
  clearProvidersConfigCache,
  getServiceFlags,
  loadProvidersConfig,
} from '../src/config/loadProviders.js';
import { BACKEND_ROOT } from '../src/config/paths.js';
import { ApiError } from '../src/errors/apiError.js';
import { createApp } from '../src/app.js';
import { createProviderBundle } from '../src/providers.js';

const ENV_KEYS = [
  'PROVIDER_MODE',
  'OPENROUTER_API_KEY',
  'LLM_MODEL',
  'LLM_PROVIDER',
  'LLM_ENABLED',
];

/** Baseline model env used by tests that need a valid provider config. */
function setDefaultModelEnv() {
  process.env.LLM_MODEL = 'deepseek/deepseek-v4-flash';
}

afterEach(() => {
  clearProvidersConfigCache();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  // Restore defaults so other test files in the same process still boot providers.
  setDefaultModelEnv();
});

describe('env provider config', () => {
  it('loads the OpenRouter LLM model from env', () => {
    setDefaultModelEnv();
    const config = loadProvidersConfig({ forceReload: true });
    assert.equal(config.llm.model, 'deepseek/deepseek-v4-flash');
    assert.equal(config.llm.provider, 'openrouter');
  });

  it('fails fast when required model env vars are missing', () => {
    delete process.env.LLM_MODEL;
    assert.throws(() => buildProvidersConfigFromEnv(), /missing required env "LLM_MODEL"/);
  });

  it('caches config across loads', () => {
    setDefaultModelEnv();
    const a = loadProvidersConfig({ forceReload: true });
    const b = loadProvidersConfig();
    assert.deepEqual(a, b);
  });

  it('swaps models by changing env only', () => {
    process.env.LLM_MODEL = 'openai/gpt-4o-mini';

    const config = loadProvidersConfig({ forceReload: true });
    assert.equal(config.llm.model, 'openai/gpt-4o-mini');
  });
});

describe('service enable flags', () => {
  it('defaults LLM to enabled', () => {
    assert.deepEqual(getServiceFlags(), { llmEnabled: true });
  });

  it('parses LLM_ENABLED from env', () => {
    process.env.LLM_ENABLED = 'false';
    assert.deepEqual(getServiceFlags(), { llmEnabled: false });

    process.env.LLM_ENABLED = 'yes';
    assert.deepEqual(getServiceFlags(), { llmEnabled: true });
  });

  it('returns 503 from patient-reply when LLM_ENABLED=false', async () => {
    setDefaultModelEnv();
    process.env.PROVIDER_MODE = 'mock';
    process.env.LLM_ENABLED = 'false';
    const providers = createProviderBundle({ mode: 'mock', forceReload: true });
    const app = createApp({ providers });
    const server = app.listen(0);
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's1',
          caseId: 'case-1-david-leung',
          turns: [],
          studentUtterance: 'Hello',
          studentSource: 'typed',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'LLM_DISABLED');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe('ApiError envelope', () => {
  it('serializes code, message, retryable, details', () => {
    const err = new ApiError({
      code: 'PROVIDER_ERROR',
      message: 'Try again',
      retryable: true,
      status: 502,
      details: { status: 429 },
    });
    assert.deepEqual(err.toJSON(), {
      code: 'PROVIDER_ERROR',
      message: 'Try again',
      retryable: true,
      details: { status: 429 },
    });
  });
});

describe('mock OpenRouter chat client', () => {
  it('returns deterministic content without network', async () => {
    let fetchCalled = false;
    const client = createOpenRouterClient({
      model: 'openai/gpt-4o-mini',
      mode: 'mock',
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('network should not be used');
      },
    });
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Hello David' }],
    });
    assert.equal(result.mock, true);
    assert.equal(result.model, 'openai/gpt-4o-mini');
    assert.match(result.content, /Hello David/);
    assert.equal(fetchCalled, false);
  });

  it('returns patient-reply selection JSON for patient-reply prompts', async () => {
    const client = createOpenRouterClient({
      model: 'openai/gpt-4o-mini',
      mode: 'mock',
    });
    const result = await client.chatCompletion({
      messages: [
        { role: 'system', content: 'You are David. Output patient-reply JSON.' },
        {
          role: 'user',
          content:
            'Latest student utterance (typed):\nThat sounds really hard.\n\nRespond with JSON only: { "tone": "good|bad", "stageId": "stage-id-or-null", "answerId": "preset-id-or-FALLBACK" }',
        },
      ],
    });
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.tone, 'good');
    assert.equal(parsed.stageId, 'lifestyle_exploration');
    assert.equal(parsed.answerId, 'A');
  });
});

describe('provider bundle + Express app', () => {
  it('wires config into clients and never exposes secrets on health', async () => {
    setDefaultModelEnv();
    process.env.PROVIDER_MODE = 'mock';
    process.env.OPENROUTER_API_KEY = 'secret-or-key';
    process.env.LLM_MODEL = 'openai/gpt-4o-mini';

    const providers = createProviderBundle({
      forceReload: true,
      mode: 'mock',
    });
    assert.equal(providers.openRouter.model, 'openai/gpt-4o-mini');
    assert.equal(providers.services.llmEnabled, true);
    assert.equal(providers.publicSummary.hasOpenRouterKey, true);
    assert.ok(!JSON.stringify(providers.publicSummary).includes('secret-or-key'));

    const app = createApp({ providers });
    const server = app.listen(0);
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.providers.llm.model, 'openai/gpt-4o-mini');
      assert.equal(body.providers.llmEnabled, true);
      assert.equal('stt' in body.providers, false);
      assert.equal('tts' in body.providers, false);
      assert.equal('speechEnabled' in body.providers, false);
      assert.ok(!JSON.stringify(body).includes('secret-or-key'));

      const removedSpeechRoute = await fetch(`http://127.0.0.1:${port}/api/speech/stt`, {
        method: 'POST',
      });
      assert.equal(removedSpeechRoute.status, 404);

      const corsRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Origin: 'http://localhost:5174' },
      });
      assert.equal(corsRes.headers.get('access-control-allow-origin'), 'http://localhost:5174');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('resolves resources from the standalone backend root', () => {
    const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    assert.equal(BACKEND_ROOT, expectedRoot);
  });
});
