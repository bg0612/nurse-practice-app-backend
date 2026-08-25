import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors/apiError.js';
import { createOpenRouterLlmClient, createOpenRouterTtsClient } from '../src/clients/openRouterClient.js';

describe('OpenRouter temporary provider adapters', () => {
  it('maps the provider-neutral LLM request to chat completions', async () => {
    let captured;
    const client = createOpenRouterLlmClient({
      apiKey: 'test-key', model: 'openai/gpt-4o-mini', mode: 'live',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"replyText":"Hello.","revealedFactIds":[]}' } }], usage: { total_tokens: 10 } }) };
      },
    });
    const result = await client.complete({
      systemPrompt: 'Stay in character.', messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 120, responseIntent: 'patient-reply',
    });
    const body = JSON.parse(captured.init.body);
    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
    assert.equal(body.model, 'openai/gpt-4o-mini');
    assert.equal(body.max_tokens, 120);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user']);
    assert.equal(result.rawText, '{"replyText":"Hello.","revealedFactIds":[]}');
  });

  it('maps TTS to the dedicated speech endpoint and returns raw audio', async () => {
    let captured;
    const client = createOpenRouterTtsClient({
      apiKey: 'test-key', model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'nova',
      responseFormat: 'mp3', mode: 'live',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
      },
    });
    const result = await client.synthesize({ text: 'Hello', voiceId: 'en-HK-SamNeural' });
    assert.equal(captured.url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.deepEqual(JSON.parse(captured.init.body), {
      input: 'Hello', model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'nova', response_format: 'mp3', speed: 1,
    });
    assert.equal(result.mediaType, 'audio/mpeg');
    assert.deepEqual([...result.audio], [1, 2, 3]);
  });

  it('requires the key only in live mode and hides upstream failure bodies', async () => {
    assert.throws(() => createOpenRouterLlmClient({ model: 'x', mode: 'live' }), /OPENROUTER_API_KEY/);
    const client = createOpenRouterLlmClient({
      apiKey: 'secret', model: 'x', mode: 'live',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'secret upstream body' } }) }),
    });
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 1, responseIntent: 'feedback' }),
      (error) => error instanceof ApiError && !JSON.stringify(error.toJSON()).includes('upstream body'),
    );
  });
});
