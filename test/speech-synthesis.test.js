import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { ApiError, apiErrorHandler } from '../src/errors/apiError.js';
import { createSpeechRoutes } from '../src/routes/speech.js';
import {
  synthesizePatientSpeech,
  validateSpeechSynthesisRequest,
} from '../src/services/speechSynthesisService.js';

const CASE_ID = 'case-1-david-leung';
const TEXT = 'I am worried this could affect my work.';
const AUDIO = Uint8Array.from([73, 68, 51]);

function provider(overrides = {}) {
  return {
    synthesize: async () => ({ mediaType: 'audio/mpeg', audio: AUDIO }),
    ...overrides,
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await fn(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function testApp(deps, jsonLimit = '16kb') {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.use(createSpeechRoutes(deps));
  app.use(apiErrorHandler);
  return app;
}

async function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/api/speech/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('speech synthesis service', () => {
  it('resolves Case 1 voice server-side and forwards provider-neutral settings', async () => {
    let request;
    const result = await synthesizePatientSpeech({
      sessionId: 'session-1',
      caseId: CASE_ID,
      text: TEXT,
      getLatestPatientReply: async () => TEXT,
      ttsProvider: provider({
        synthesize: async (input) => {
          request = input;
          return { mediaType: 'audio/mpeg', audio: AUDIO };
        },
      }),
    });

    assert.deepEqual(request, {
      text: TEXT,
      voiceId: 'en-HK-SamNeural',
      language: 'en',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: '0%',
      pitch: '0%',
    });
    assert.equal(result.mediaType, 'audio/mpeg');
  });

  it('supports a sessionRegistry implementing getLatestPatientReply', async () => {
    const calls = [];
    await synthesizePatientSpeech({
      sessionId: 'session-1',
      caseId: CASE_ID,
      text: TEXT,
      sessionRegistry: {
        getLatestPatientReply(sessionId, caseId) {
          calls.push([sessionId, caseId]);
          return { patientReply: { replyText: TEXT } };
        },
      },
      ttsProvider: provider(),
    });
    assert.deepEqual(calls, [['session-1', CASE_ID]]);
  });

  it('rejects empty and unreasonable request fields', async () => {
    for (const body of [
      {},
      { sessionId: 'session-1', caseId: CASE_ID, text: '' },
      { sessionId: 's'.repeat(129), caseId: CASE_ID, text: TEXT },
      { sessionId: 'session-1', caseId: CASE_ID, text: 'x'.repeat(10_001) },
    ]) {
      assert.throws(
        () => validateSpeechSynthesisRequest(body),
        (error) => error instanceof ApiError && error.code === 'VALIDATION' && error.status === 400,
      );
    }

  });

  it('synthesizes an authoritative reply even when it exceeds the prompt target', async () => {
    const longReply = `I understand. ${'This is a longer reply. '.repeat(12)}`;
    let synthesizedText;
    const ttsProvider = provider({
      synthesize: async ({ text }) => {
        synthesizedText = text;
        return { mediaType: 'audio/mpeg', audio: AUDIO };
      },
    });
    await synthesizePatientSpeech({
      sessionId: 'session-1',
      caseId: CASE_ID,
      text: longReply,
      getLatestPatientReply: async () => longReply,
      ttsProvider,
    });
    assert.equal(synthesizedText, longReply);
  });

  it('rejects text that differs from the latest committed patient reply', async () => {
    await assert.rejects(
      () => synthesizePatientSpeech({
        sessionId: 'session-1',
        caseId: CASE_ID,
        text: TEXT,
        getLatestPatientReply: async () => 'A different committed reply.',
        ttsProvider: provider(),
      }),
      (error) =>
        error instanceof ApiError &&
        error.code === 'VALIDATION' &&
        error.details?.field === 'text',
    );
  });

  it('rejects missing sessions and preserves CASE_NOT_FOUND', async () => {
    await assert.rejects(
      () => synthesizePatientSpeech({
        sessionId: 'missing',
        caseId: CASE_ID,
        text: TEXT,
        getLatestPatientReply: async () => null,
        ttsProvider: provider(),
      }),
      (error) => error instanceof ApiError && error.code === 'SESSION_NOT_FOUND',
    );
    await assert.rejects(
      () => synthesizePatientSpeech({
        sessionId: 'session-1',
        caseId: 'missing-case',
        text: TEXT,
        getLatestPatientReply: async () => TEXT,
        ttsProvider: provider(),
      }),
      (error) => error instanceof ApiError && error.code === 'CASE_NOT_FOUND',
    );
  });

  it('does not leak unexpected session-registry errors', async () => {
    await assert.rejects(
      () => synthesizePatientSpeech({
        sessionId: 'session-1',
        caseId: CASE_ID,
        text: TEXT,
        getLatestPatientReply: async () => { throw new Error('internal session secret'); },
        ttsProvider: provider(),
      }),
      (error) =>
        error instanceof ApiError &&
        error.code === 'TTS_FAILED' &&
        !JSON.stringify(error.toJSON()).includes('secret'),
    );
  });

  it('normalizes provider failures and malformed results to recoverable TTS_FAILED', async () => {
    for (const synthesize of [
      async () => { throw new Error('provider key=secret'); },
      async () => ({ mediaType: 'text/plain', audio: AUDIO }),
      async () => ({ mediaType: 'audio/mpeg', audio: new Uint8Array() }),
    ]) {
      await assert.rejects(
        () => synthesizePatientSpeech({
          sessionId: 'session-1',
          caseId: CASE_ID,
          text: TEXT,
          getLatestPatientReply: async () => TEXT,
          ttsProvider: provider({ synthesize }),
        }),
        (error) =>
          error instanceof ApiError &&
          error.code === 'TTS_FAILED' &&
          error.retryable === true &&
          !JSON.stringify(error.toJSON()).includes('secret'),
      );
    }
  });
});

describe('POST /api/speech/synthesize', () => {
  it('returns audio bytes and the provider Content-Type', async () => {
    const app = testApp({
      ttsProvider: provider(),
      getLatestPatientReply: async (sessionId, caseId) =>
        sessionId === 'session-1' && caseId === CASE_ID ? TEXT : null,
    });
    await withServer(app, async (port) => {
      const res = await post(port, { sessionId: 'session-1', caseId: CASE_ID, text: TEXT });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'audio/mpeg');
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...AUDIO]);
    });
  });

  it('does not accept a client voiceId override', async () => {
    let request;
    const app = testApp({
      ttsProvider: provider({
        synthesize: async (input) => {
          request = input;
          return { mediaType: 'audio/mpeg', audio: AUDIO };
        },
      }),
      getLatestPatientReply: async () => TEXT,
    });
    await withServer(app, async (port) => {
      const res = await post(port, {
        sessionId: 'session-1',
        caseId: CASE_ID,
        text: TEXT,
        voiceId: 'attacker-controlled-voice',
      });
      assert.equal(res.status, 200);
      assert.equal(request.voiceId, 'en-HK-SamNeural');
    });
  });

  it('accepts the WP-03 activeSessionRegistry injection name', async () => {
    const app = testApp({
      ttsProvider: provider(),
      activeSessionRegistry: {
        getLatestPatientReply(sessionId, caseId) {
          assert.equal(sessionId, 'session-1');
          assert.equal(caseId, CASE_ID);
          return TEXT;
        },
      },
    });
    await withServer(app, async (port) => {
      const res = await post(port, { sessionId: 'session-1', caseId: CASE_ID, text: TEXT });
      assert.equal(res.status, 200);
    });
  });

  it('returns safe error envelopes for mismatch, session, case, and provider failures', async () => {
    const cases = [
      {
        deps: { ttsProvider: provider(), getLatestPatientReply: async () => 'different' },
        body: { sessionId: 'session-1', caseId: CASE_ID, text: TEXT },
        status: 400,
        code: 'VALIDATION',
      },
      {
        deps: { ttsProvider: provider(), getLatestPatientReply: async () => null },
        body: { sessionId: 'missing', caseId: CASE_ID, text: TEXT },
        status: 404,
        code: 'SESSION_NOT_FOUND',
      },
      {
        deps: { ttsProvider: provider(), getLatestPatientReply: async () => TEXT },
        body: { sessionId: 'session-1', caseId: 'missing-case', text: TEXT },
        status: 404,
        code: 'CASE_NOT_FOUND',
      },
      {
        deps: {
          ttsProvider: provider({ synthesize: async () => { throw new Error('raw secret'); } }),
          getLatestPatientReply: async () => TEXT,
        },
        body: { sessionId: 'session-1', caseId: CASE_ID, text: TEXT },
        status: 502,
        code: 'TTS_FAILED',
      },
    ];

    for (const item of cases) {
      await withServer(testApp(item.deps), async (port) => {
        const res = await post(port, item.body);
        assert.equal(res.status, item.status);
        const body = await res.json();
        assert.equal(body.code, item.code);
        assert.equal(JSON.stringify(body).includes('secret'), false);
      });
    }
  });
});
