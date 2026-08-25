import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors/apiError.js';
import {
  AZURE_SPEECH_MANAGED_IDENTITY_SCOPE,
  createAzureSpeechClient,
  escapeSsmlText,
} from '../src/clients/azureSpeechClient.js';

const REQUEST = {
  text: `David & <friends> say "hello" and 'bye'.`,
  voiceId: 'en-HK-SamNeural',
  language: 'en',
  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
  rate: '0%',
  pitch: '0%',
};

function response(bytes = [1, 2, 3], contentType = 'audio/mpeg') {
  return {
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe('Azure Speech TtsProvider adapter', () => {
  it('escapes SSML text and sends CaseConfig voice/output tuning', async () => {
    let captured;
    const client = createAzureSpeechClient({
      endpoint: 'https://speech.example.test',
      authMode: 'api-key',
      apiKey: 'not-a-real-secret',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return response();
      },
    });

    const result = await client.synthesize(REQUEST);

    assert.equal(captured.url, 'https://speech.example.test/cognitiveservices/v1');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['X-Microsoft-OutputFormat'], REQUEST.outputFormat);
    assert.equal(captured.init.headers['Ocp-Apim-Subscription-Key'], 'not-a-real-secret');
    assert.match(captured.init.body, /<voice name="en-HK-SamNeural">/);
    assert.match(captured.init.body, /<prosody rate="0%" pitch="0%">/);
    assert.match(
      captured.init.body,
      /David &amp; &lt;friends&gt; say &quot;hello&quot; and &apos;bye&apos;\./,
    );
    assert.doesNotMatch(captured.init.body, /David & <friends>/);
    assert.equal(result.mediaType, 'audio/mpeg');
    assert.deepEqual([...result.audio], [1, 2, 3]);
  });

  it('uses an injected managed-identity token provider', async () => {
    let scope;
    let authorization;
    const client = createAzureSpeechClient({
      endpoint: 'https://speech.example.test/cognitiveservices/v1',
      authMode: 'managed-identity',
      accessTokenProvider: async (requestedScope) => {
        scope = requestedScope;
        return 'test-token';
      },
      fetchImpl: async (_url, init) => {
        authorization = init.headers.Authorization;
        return response();
      },
    });

    await client.synthesize(REQUEST);
    assert.equal(scope, AZURE_SPEECH_MANAGED_IDENTITY_SCOPE);
    assert.equal(authorization, 'Bearer test-token');
  });

  it('validates endpoint, auth, and timeout configuration without network calls', () => {
    assert.throws(
      () => createAzureSpeechClient({ endpoint: 'http://unsafe.test', authMode: 'api-key', apiKey: 'x' }),
      /HTTPS URL/,
    );
    assert.throws(
      () => createAzureSpeechClient({ endpoint: 'https://speech.test', authMode: 'api-key' }),
      /apiKey is required/,
    );
    assert.throws(
      () => createAzureSpeechClient({ endpoint: 'https://speech.test', authMode: 'managed-identity' }),
      /accessTokenProvider is required/,
    );
    assert.throws(
      () => createAzureSpeechClient({ endpoint: 'https://speech.test', authMode: 'api-key', apiKey: 'x', timeoutMs: 0 }),
      /timeoutMs/,
    );
  });

  it('normalizes HTTP, auth, empty-audio, and transport failures without raw leakage', async () => {
    const failures = [
      async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' } }),
      async () => response([]),
      async () => { throw new Error('secret upstream payload'); },
    ];

    for (const fetchImpl of failures) {
      const client = createAzureSpeechClient({
        endpoint: 'https://speech.test',
        authMode: 'api-key',
        apiKey: 'super-secret-key',
        fetchImpl,
      });
      await assert.rejects(
        () => client.synthesize(REQUEST),
        (error) =>
          error instanceof ApiError &&
          error.code === 'TTS_FAILED' &&
          error.retryable === true &&
          !JSON.stringify(error.toJSON()).includes('secret'),
      );
    }
  });

  it('exports deterministic XML escaping', () => {
    assert.equal(escapeSsmlText(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
  });
});

