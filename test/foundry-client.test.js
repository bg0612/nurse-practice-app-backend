import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFoundryClient,
  FOUNDRY_MANAGED_IDENTITY_SCOPE,
} from '../src/clients/foundryClient.js';
import { ApiError } from '../src/errors/apiError.js';

const BASE_OPTIONS = Object.freeze({
  endpoint: 'https://nursing-ai.services.ai.azure.com',
  deploymentName: 'deepseek-v4-flash-prod',
  model: 'DeepSeek-V4-Flash',
  modelVersion: '2026-04-23',
  deploymentType: 'pay-as-you-go',
  authMode: 'api-key',
  apiKey: 'foundry-test-secret',
});

function successResponse(content = '{"replyText":"I understand.","revealedFactIds":[]}') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function completionInput(overrides = {}) {
  return {
    systemPrompt: 'Act only as the configured patient.',
    messages: [{ role: 'user', content: 'How are you feeling?' }],
    maxOutputTokens: 120,
    responseIntent: 'patient-reply',
    ...overrides,
  };
}

describe('Microsoft Foundry client', () => {
  it('uses the current Foundry OpenAI-v1 route and forwards deployment/token cap', async () => {
    let captured;
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      mode: 'live',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return successResponse();
      },
    });

    const result = await client.complete(completionInput());
    const body = JSON.parse(captured.init.body);

    assert.equal(
      captured.url,
      'https://nursing-ai.services.ai.azure.com/openai/v1/chat/completions',
    );
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['api-key'], 'foundry-test-secret');
    assert.equal(captured.init.headers.Authorization, undefined);
    assert.equal(body.model, 'deepseek-v4-flash-prod');
    assert.equal(body.max_output_tokens, 120);
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'Act only as the configured patient.' },
      { role: 'user', content: 'How are you feeling?' },
    ]);
    assert.equal(result.rawText, '{"replyText":"I understand.","revealedFactIds":[]}');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 8 });
    assert.equal(result.modelVersion, '2026-04-23');
  });

  it('does not append the route when a full completion endpoint is configured', async () => {
    let requestedUrl;
    const endpoint =
      'https://nursing-ai.services.ai.azure.com/openai/v1/chat/completions';
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      endpoint,
      mode: 'live',
      fetchImpl: async (url) => {
        requestedUrl = url;
        return successResponse();
      },
    });

    await client.complete(completionInput());
    assert.equal(requestedUrl, endpoint);
  });

  it('supports managed identity through an injected token-provider contract', async () => {
    let requestedScope;
    let authorization;
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      authMode: 'managed-identity',
      apiKey: undefined,
      accessTokenProvider: async (scope) => {
        requestedScope = scope;
        return 'short-lived-access-token';
      },
      mode: 'live',
      fetchImpl: async (_url, init) => {
        authorization = init.headers.Authorization;
        assert.equal(init.headers['api-key'], undefined);
        return successResponse();
      },
    });

    await client.complete(completionInput());
    assert.equal(requestedScope, FOUNDRY_MANAGED_IDENTITY_SCOPE);
    assert.equal(authorization, 'Bearer short-lived-access-token');
  });

  it('fails fast when live authentication material/provider is absent', () => {
    assert.throws(
      () =>
        createFoundryClient({
          ...BASE_OPTIONS,
          apiKey: undefined,
          mode: 'live',
        }),
      /apiKey is required/,
    );
    assert.throws(
      () =>
        createFoundryClient({
          ...BASE_OPTIONS,
          authMode: 'managed-identity',
          apiKey: undefined,
          mode: 'live',
        }),
      /accessTokenProvider is required/,
    );
  });

  it('validates endpoint, deployment, model version, deployment type, and input', async () => {
    assert.throws(
      () => createFoundryClient({ ...BASE_OPTIONS, endpoint: 'http://unsafe.test' }),
      /HTTPS URL/,
    );
    assert.throws(
      () => createFoundryClient({ ...BASE_OPTIONS, deploymentName: 'FW-deepseek' }),
      /not Direct from Azure/,
    );
    assert.throws(
      () => createFoundryClient({ ...BASE_OPTIONS, modelVersion: '2026-01-01' }),
      /version 2026-04-23/,
    );
    assert.throws(
      () => createFoundryClient({ ...BASE_OPTIONS, deploymentType: 'provisioned' }),
      /pay-as-you-go/,
    );

    const client = createFoundryClient({ ...BASE_OPTIONS, mode: 'mock' });
    await assert.rejects(
      client.complete(completionInput({ maxOutputTokens: 0 })),
      (error) => error instanceof ApiError && error.code === 'PROVIDER_BAD_REQUEST',
    );
  });

  it('returns deterministic mock output without touching fetch', async () => {
    let fetchCalled = false;
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      apiKey: undefined,
      mode: 'mock',
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('must not make a network request');
      },
    });

    const result = await client.complete(completionInput());
    assert.deepEqual(JSON.parse(result.rawText), {
      replyText: "I'm listening. Could you ask me a little more specifically?",
      revealedFactIds: [],
    });
    assert.equal(result.mock, true);
    assert.equal(fetchCalled, false);
  });

  it('normalizes provider failures without leaking keys, endpoints, or raw bodies', async () => {
    const leakedValues = [
      BASE_OPTIONS.apiKey,
      BASE_OPTIONS.endpoint,
      'sensitive upstream diagnostic',
    ];
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      mode: 'live',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code: 'RateLimitReached', message: 'sensitive upstream diagnostic' },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(client.complete(completionInput()), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { status: 429, providerCode: 'RateLimitReached' });
      const serialized = JSON.stringify(error.toJSON());
      for (const leaked of leakedValues) assert.ok(!serialized.includes(leaked));
      return true;
    });
  });

  it('normalizes network errors without exposing the thrown message', async () => {
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      mode: 'live',
      fetchImpl: async () => {
        throw new Error('request included foundry-test-secret');
      },
    });

    await assert.rejects(client.complete(completionInput()), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.ok(!JSON.stringify(error.toJSON()).includes('foundry-test-secret'));
      return true;
    });
  });

  it('aborts at the configured timeout and returns a retryable safe error', async () => {
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      mode: 'live',
      timeoutMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });

    await assert.rejects(client.complete(completionInput()), (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.status, 504);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { timeoutMs: 5 });
      return true;
    });
  });

  it('rejects a successful response with no assistant text', async () => {
    const client = createFoundryClient({
      ...BASE_OPTIONS,
      mode: 'live',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await assert.rejects(
      client.complete(completionInput()),
      (error) => error.code === 'PROVIDER_BAD_RESPONSE' && error.retryable,
    );
  });
});
