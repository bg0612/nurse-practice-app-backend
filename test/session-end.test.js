// backend/test/session-end.test.js
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { CASE1_EDUCATION_TARGET_IDS } from '../src/models/caseModel.js';
import { createProviderBundle } from '../src/providers.js';

const CASE_ID = 'case-1-david-leung';

/**
 * @param {import('express').Express} app
 */
async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await fn(port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * Poll GET /api/session/:sessionId/feedback until ready or error.
 * @param {number} port
 * @param {string} sessionId
 */
async function pollFeedback(port, sessionId, maxTries = 50) {
  for (let i = 0; i < maxTries; i += 1) {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionId}/feedback`,
    );
    if (res.status === 200) {
      const body = await res.json();
      if (body.status === 'ready' || body.status === 'error') return body;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('feedback never became ready');
}

function sampleBody(overrides = {}) {
  return {
    sessionId: 'sess-end-1',
    caseId: CASE_ID,
    startedAt: '2026-07-22T08:00:00.000Z',
    endedAt: '2026-07-22T08:15:00.000Z',
    turns: [
      {
        index: 0,
        role: 'patient',
        text: "I'm David, just diagnosed with diabetes last month.",
        createdAt: '2026-07-22T08:00:00.000Z',
      },
      {
        index: 1,
        role: 'student',
        text: 'Tell me about your lunch habits.',
        createdAt: '2026-07-22T08:01:00.000Z',
        source: 'voice',
      },
      {
        index: 2,
        role: 'patient',
        text: 'I host dim sum lunches with clients.',
        createdAt: '2026-07-22T08:01:30.000Z',
        tone: 'good',
        stageId: 'healthy-eating',
        answerId: 'DIM_SUM',
      },
    ],
    ...overrides,
  };
}

describe('POST /api/session/end (§6.4) + GET feedback', () => {
  it('returns immediately, then feedback becomes ready via polling', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleBody()),
      });
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.feedbackStatus, 'generating');

      const feedbackBody = await pollFeedback(port, 'sess-end-1');
      assert.equal(feedbackBody.status, 'ready');
      assert.ok(feedbackBody.feedback);
      assert.equal(feedbackBody.feedback.domains.length, 4);
      assert.deepEqual(
        feedbackBody.feedback.domains.map((d) => d.id),
        [...CASE1_EDUCATION_TARGET_IDS],
      );
      for (const d of feedbackBody.feedback.domains) {
        assert.ok(typeof d.label === 'string' && d.label.length > 0);
        assert.equal(typeof d.covered, 'boolean');
      }
      assert.ok(typeof feedbackBody.feedback.toneSummary === 'string');
      assert.ok(typeof feedbackBody.feedback.overallComment === 'string');
      assert.ok(Array.isArray(feedbackBody.feedback.improvementTips));
      assert.match(feedbackBody.feedback.reflectionQuestion, /differently/i);
    });
  });

  it('GET feedback reports generating while in progress', async () => {
    process.env.PROVIDER_MODE = 'mock';
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
      generateFeedbackFn: async () => {
        await gate;
        return {
          domains: [],
          toneSummary: 't',
          overallComment: 'o',
          improvementTips: ['x'],
          reflectionQuestion: 'Would you do anything differently?',
        };
      },
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleBody({ sessionId: 'sess-gate-1' })),
      });
      assert.equal(res.status, 200);

      const generating = await fetch(
        `http://127.0.0.1:${port}/api/session/sess-gate-1/feedback`,
      );
      assert.equal(generating.status, 200);
      const generatingBody = await generating.json();
      assert.equal(generatingBody.status, 'generating');

      release();

      const feedbackBody = await pollFeedback(port, 'sess-gate-1');
      assert.equal(feedbackBody.status, 'ready');
    });
  });

  it('returns VALIDATION for missing fields', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: CASE_ID }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION');
      assert.equal(body.retryable, false);
    });
  });

  it('returns VALIDATION for an invalid delta tone value', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          sampleBody({
            turns: [
              ...sampleBody().turns.slice(0, 2),
              {
                ...sampleBody().turns[2],
                tone: 'mild',
              },
            ],
          }),
        ),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION');
      assert.equal(body.details.field, 'turns[2].tone');
    });
  });

  it('POST succeeds and GET reports error when background feedback throws', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
      generateFeedbackFn: async () => {
        throw new Error('LLM down');
      },
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleBody()),
      });
      assert.equal(res.status, 200);

      const feedbackBody = await pollFeedback(port, 'sess-end-1');
      assert.equal(feedbackBody.status, 'error');
    });
  });

  it('returns 404 for unknown session feedback', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/session/never-ended-123/feedback`,
      );
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.code, 'FEEDBACK_NOT_FOUND');
    });
  });
});
