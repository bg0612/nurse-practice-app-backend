// backend/test/patient-reply.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import { createOpenRouterClient } from '../src/clients/openRouterClient.js';
import { PROMPTS_DIR } from '../src/config/paths.js';
import {
  buildPatientReplyMessages,
  generatePatientReply,
  isLowInformationAcknowledgement,
  parsePatientReplyContent,
  PATIENT_REPLY_TONES,
  resolvePatientReplySelection,
} from '../src/services/patientReplyService.js';
import { loadCaseById } from '../src/models/caseModel.js';
import { apiErrorHandler, ApiError } from '../src/errors/apiError.js';
import { createDialogueRoutes } from '../src/routes/dialogue.js';

const CASE_ID = 'case-1-david-leung';

const EMPATHETIC =
  'It sounds like your days at the bank are really long — how has that been affecting meals?';
const JUDGMENTAL =
  "You shouldn't be eating dim sum at all if you care about your career. Stop being defensive.";
const WRONG_ADVICE =
  'I understand you enjoy dim sum — you should eat more dim sum since it makes you happy.';
const WRONG_ADVICE_CUT_CARBS =
  'I hear you — the safest plan is to cut out all carbohydrates and never eat rice again.';
const WRONG_ADVICE_STOP_MEDS =
  'Since lifestyle matters most, you can stop Metformin and manage with diet alone.';

afterEach(() => {
  delete process.env.PROVIDER_MODE;
  delete process.env.OPENROUTER_TIMEOUT_MS;
});

/**
 * Minimal app with M5 route only (avoids unfinished parallel module wiring in createApp).
 * @param {{ openRouter: object, casesDir?: string, promptsDir?: string }} deps
 */
function createPatientReplyApp(deps) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.locals.providers = { openRouter: deps.openRouter };
  app.use(createDialogueRoutes({ casesDir: deps.casesDir, promptsDir: deps.promptsDir }));
  app.use(apiErrorHandler);
  return app;
}

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
 * Mock OpenRouter that returns selection JSON from utterance heuristics.
 * @param {{ failTimes?: number, failContent?: string, throwProvider?: boolean }} [opts]
 */
function createMockOpenRouter(opts = {}) {
  let calls = 0;
  return {
    mode: 'mock',
    model: 'mock/patient-reply',
    get callCount() {
      return calls;
    },
    async chatCompletion({ messages }) {
      calls += 1;
      if (opts.throwProvider) {
        throw new ApiError({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'network down',
          retryable: true,
          status: 502,
        });
      }
      if (opts.failTimes && calls <= opts.failTimes) {
        return { content: opts.failContent ?? 'NOT_JSON{{{', model: 'mock', mock: true };
      }

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = lastUser?.content ?? '';
      const wrongAdvice =
        /eat more (of )?dim sum|more dim sum|skip the (post-)?lunch walk|don't worry about carbs|cut out all carbohydrates|never eat rice|stop (taking )?metformin|stop metformin/i.test(
          text,
        );
      const judgmental =
        /shouldn't|should not|lazy|unacceptable|no excuses|stop being defensive|complications will end/i.test(
          text,
        );

      if (wrongAdvice) {
        return {
          content: JSON.stringify({
            tone: 'good',
            stageId: null,
            answerId: 'FALLBACK',
          }),
          model: 'mock',
          mock: true,
        };
      }

      if (judgmental) {
        return {
          content: JSON.stringify({
            tone: 'bad',
            stageId: 'healthy_coping',
            answerId: 'B',
          }),
          model: 'mock',
          mock: true,
        };
      }

      return {
        content: JSON.stringify({
          tone: 'good',
          stageId: 'lifestyle_exploration',
          answerId: 'A',
        }),
        model: 'mock',
        mock: true,
      };
    },
  };
}

describe('patient reply prompts (separate from M6)', () => {
  it('ships a select-only patient-reply.system.md prompt', () => {
    const systemPath = path.join(PROMPTS_DIR, 'patient-reply.system.md');

    const system = readFileSync(systemPath, 'utf8');
    assert.match(system, /David Leung/);
    assert.match(system, /answerId/);
    assert.match(system, /stageId/);
    assert.match(system, /\bgood\b/);
    assert.match(system, /\bbad\b/);
    assert.match(system, /Never output `replyText`/);
    assert.match(system, /Wrong advice → FALLBACK|incorrect examples/i);
    assert.match(system, /correct direction/i);
    assert.doesNotMatch(system, /toneSeverity|moderate|severe/);
    assert.doesNotMatch(system, /educationTargets|domain checklist|reflectionQuestion/i);
  });

  it('builds messages with persona, rubric, history, and latest utterance', () => {
    const caseConfig = loadCaseById(CASE_ID);
    const messages = buildPatientReplyMessages({
      caseConfig,
      turns: [
        { role: 'patient', text: caseConfig.opening.text, createdAt: '2026-01-01T00:00:00.000Z' },
        { role: 'student', text: 'How are you feeling?', source: 'typed', createdAt: '2026-01-01T00:00:01.000Z' },
        {
          role: 'patient',
          text: 'Stressed about work.',
          tone: 'good',
          stageId: 'lifestyle_exploration',
          answerId: 'A',
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      ],
      studentUtterance: EMPATHETIC,
      studentSource: 'voice',
      highestUnlockedOrder: 2,
    });

    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /David Leung|bank manager/i);
    assert.match(messages[0].content, /Tone guidance/i);
    assert.match(messages[0].content, /Expected education directions/i);
    assert.match(messages[0].content, /Meal sequencing/i);
    assert.match(messages[0].content, /Content guidance/i);
    assert.match(messages[0].content, /Selection principles/i);
    assert.match(messages[0].content, /Correct directions/i);
    assert.match(messages[0].content, /10-minute walk|Metformin|carbohydrates/i);
    assert.match(messages[0].content, /eat more of it|Incorrect advice examples/i);
    assert.match(messages[0].content, /Unlocked stages/i);
    assert.match(messages[0].content, /lifestyle_exploration/i);
    assert.equal(messages.at(-1)?.role, 'user');
    assert.match(messages.at(-1)?.content ?? '', /voice/);
    assert.match(messages.at(-1)?.content ?? '', /bank are really long/);
    assert.match(messages.at(-1)?.content ?? '', /Current highest unlocked order: 2/);
  });

  it('includes the latest utterance only once when an older client also sends it in turns', () => {
    const caseConfig = loadCaseById(CASE_ID);
    const latest = 'Can you tell me about your meals?';
    const messages = buildPatientReplyMessages({
      caseConfig,
      turns: [
        { role: 'patient', text: caseConfig.opening.text },
        { role: 'student', text: latest },
      ],
      studentUtterance: latest,
      studentSource: 'typed',
      highestUnlockedOrder: 2,
    });

    const occurrences = messages
      .map((message) => message.content)
      .join('\n')
      .split(latest).length - 1;
    assert.equal(occurrences, 1);
    assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
  });
});

describe('isLowInformationAcknowledgement', () => {
  it('matches standalone acknowledgement variants only', () => {
    for (const utterance of ['OK', 'okay.', 'Cool!', 'yes', 'Thanks', 'thank you!', 'Got it.', 'understood']) {
      assert.equal(isLowInformationAcknowledgement(utterance), true, utterance);
    }
    for (const utterance of [
      'Yes, I can walk for ten minutes after lunch.',
      'Okay, can you tell me which carbohydrates to reduce?',
      'Thanks for explaining how Metformin works.',
      'I understood that vegetables should come first.',
    ]) {
      assert.equal(isLowInformationAcknowledgement(utterance), false, utterance);
    }
  });
});

describe('parsePatientReplyContent', () => {
  it('accepts valid JSON and fenced JSON', () => {
    for (const tone of PATIENT_REPLY_TONES) {
      const result = parsePatientReplyContent(
        JSON.stringify({ tone, stageId: 'lifestyle_exploration', answerId: 'A' }),
      );
      assert.equal(result.tone, tone);
      assert.equal(result.stageId, 'lifestyle_exploration');
      assert.equal(result.answerId, 'A');
    }
    const fenced = parsePatientReplyContent(
      '```json\n{"tone":"bad","stageId":null,"answerId":"FALLBACK"}\n```',
    );
    assert.equal(fenced.tone, 'bad');
    assert.equal(fenced.stageId, null);
    assert.equal(fenced.answerId, 'FALLBACK');
  });

  it('rejects invalid JSON with LLM_BAD_JSON', () => {
    assert.throws(
      () => parsePatientReplyContent('not-json'),
      (err) => err instanceof ApiError && err.code === 'LLM_BAD_JSON' && err.retryable === true,
    );
    assert.throws(
      () => parsePatientReplyContent(JSON.stringify({ tone: 'extreme', stageId: 'x', answerId: 'A' })),
      (err) => err instanceof ApiError && err.code === 'LLM_BAD_JSON',
    );
  });
});

describe('resolvePatientReplySelection', () => {
  const caseConfig = loadCaseById(CASE_ID);

  it('maps valid good and bad selections to preset text', () => {
    const good = resolvePatientReplySelection(
      caseConfig,
      { tone: 'good', stageId: 'lifestyle_exploration', answerId: 'A' },
      2,
    );
    assert.equal(good.replyText, caseConfig.presetReplies.stages[0].good[0].text);
    assert.equal(good.highestUnlockedOrder, 3);
    assert.equal(good.currentStageId, 'lifestyle_exploration');
    assert.equal(good.videoRef, caseConfig.presetReplies.stages[0].good[0].videoRef ?? null);

    const bad = resolvePatientReplySelection(
      caseConfig,
      { tone: 'bad', stageId: 'healthy_eating', answerId: 'B' },
      3,
    );
    assert.equal(bad.replyText, caseConfig.presetReplies.stages[1].bad[0].text);
    assert.equal(bad.highestUnlockedOrder, 4);
    assert.equal(bad.currentStageId, 'healthy_eating');
    assert.equal(bad.videoRef, caseConfig.presetReplies.stages[1].bad[0].videoRef ?? null);
  });

  it('forces FALLBACK for forward skips without increasing unlock', () => {
    const result = resolvePatientReplySelection(
      caseConfig,
      { tone: 'good', stageId: 'healthy_coping', answerId: 'A' },
      2,
    );
    assert.equal(result.answerId, 'FALLBACK');
    assert.equal(result.replyText, caseConfig.presetReplies.fallback.text);
    assert.equal(result.highestUnlockedOrder, 2);
    assert.equal(result.currentStageId, 'lifestyle_exploration');
  });

  it('forces FALLBACK for invalid answer ids', () => {
    const result = resolvePatientReplySelection(
      caseConfig,
      { tone: 'good', stageId: 'healthy_eating', answerId: 'Z' },
      3,
    );
    assert.equal(result.answerId, 'FALLBACK');
    assert.equal(result.stageId, null);
    assert.equal(result.highestUnlockedOrder, 3);
    assert.equal(result.currentStageId, 'healthy_eating');
  });
});

describe('generatePatientReply (mocked OpenRouter)', () => {
  it('uses temperature 0.2 for model-selected replies', async () => {
    let receivedTemperature;
    const openRouter = {
      async chatCompletion({ temperature }) {
        receivedTemperature = temperature;
        return {
          content: JSON.stringify({
            tone: 'good',
            stageId: 'lifestyle_exploration',
            answerId: 'A',
          }),
        };
      },
    };
    await generatePatientReply({
      caseId: CASE_ID,
      turns: [],
      studentUtterance: EMPATHETIC,
      studentSource: 'typed',
      highestUnlockedOrder: 2,
      openRouter,
    });
    assert.equal(receivedTemperature, 0.2);
  });

  it('returns deterministic FALLBACK for standalone acknowledgements without calling the model', async () => {
    for (const studentUtterance of ['OK', 'okay.', 'Cool!', 'yes', 'Thanks', 'thank you', 'Got it', 'understood']) {
      let called = false;
      const result = await generatePatientReply({
        caseId: CASE_ID,
        turns: [],
        studentUtterance,
        studentSource: 'typed',
        highestUnlockedOrder: 2,
        openRouter: {
          async chatCompletion() {
            called = true;
            throw new Error('should not be called');
          },
        },
      });
      assert.equal(called, false, studentUtterance);
      assert.equal(result.tone, 'good', studentUtterance);
      assert.equal(result.stageId, null, studentUtterance);
      assert.equal(result.answerId, 'FALLBACK', studentUtterance);
      assert.equal(result.highestUnlockedOrder, 2, studentUtterance);
      assert.equal(result.currentStageId, 'lifestyle_exploration', studentUtterance);
    }
  });

  it('returns cooperative reply for empathetic utterance', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const openRouter = createMockOpenRouter();
    const result = await generatePatientReply({
      caseId: CASE_ID,
      turns: [],
      studentUtterance: EMPATHETIC,
      studentSource: 'typed',
      highestUnlockedOrder: 2,
      openRouter,
    });
    assert.equal(result.tone, 'good');
    assert.equal(result.stageId, 'lifestyle_exploration');
    assert.equal(result.answerId, 'A');
    assert.match(result.replyText, /skip breakfast|dim sum|exercise/i);
    assert.equal(result.highestUnlockedOrder, 3);
    assert.equal(openRouter.callCount, 1);
  });

  it('returns resistant reply for judgmental utterance', async () => {
    const openRouter = createMockOpenRouter();
    const result = await generatePatientReply({
      caseId: CASE_ID,
      turns: [],
      studentUtterance: JUDGMENTAL,
      studentSource: 'voice',
      highestUnlockedOrder: 5,
      openRouter,
    });
    assert.equal(result.tone, 'bad');
    assert.equal(result.stageId, 'healthy_coping');
    assert.equal(result.answerId, 'B');
    assert.match(result.replyText, /don.?t want to talk|afraid/i);
  });

  it('returns FALLBACK for empathetic but clinically wrong advice', async () => {
    const openRouter = createMockOpenRouter();
    const result = await generatePatientReply({
      caseId: CASE_ID,
      turns: [],
      studentUtterance: WRONG_ADVICE,
      studentSource: 'typed',
      highestUnlockedOrder: 3,
      openRouter,
    });
    assert.equal(result.tone, 'good');
    assert.equal(result.stageId, null);
    assert.equal(result.answerId, 'FALLBACK');
    assert.match(result.replyText, /doctor|clinic|explain that another way/i);
    assert.equal(result.highestUnlockedOrder, 3);
  });

  it('returns FALLBACK for cut-all-carbs and stop-metformin advice', async () => {
    const openRouter = createMockOpenRouter();
    for (const utterance of [WRONG_ADVICE_CUT_CARBS, WRONG_ADVICE_STOP_MEDS]) {
      const result = await generatePatientReply({
        caseId: CASE_ID,
        turns: [],
        studentUtterance: utterance,
        studentSource: 'typed',
        highestUnlockedOrder: 3,
        openRouter,
      });
      assert.equal(result.answerId, 'FALLBACK');
      assert.equal(result.stageId, null);
      assert.match(result.replyText, /doctor|clinic|explain that another way/i);
    }
  });

  it('retries once on bad JSON then succeeds', async () => {
    const openRouter = createMockOpenRouter({ failTimes: 1 });
    const result = await generatePatientReply({
      caseId: CASE_ID,
      turns: [],
      studentUtterance: EMPATHETIC,
      studentSource: 'typed',
      highestUnlockedOrder: 2,
      openRouter,
    });
    assert.equal(result.tone, 'good');
    assert.equal(openRouter.callCount, 2);
  });

  it('returns LLM_BAD_JSON after retry exhausted', async () => {
    const openRouter = createMockOpenRouter({ failTimes: 5, failContent: '{bad' });
    await assert.rejects(
      () =>
        generatePatientReply({
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
          openRouter,
        }),
      (err) =>
        err instanceof ApiError &&
        err.code === 'LLM_BAD_JSON' &&
        err.retryable === true &&
        err.status === 502,
    );
    assert.equal(openRouter.callCount, 2);
  });

  it('maps provider failures to LLM_FAILED', async () => {
    const openRouter = createMockOpenRouter({ throwProvider: true });
    await assert.rejects(
      () =>
        generatePatientReply({
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
          openRouter,
        }),
      (err) =>
        err instanceof ApiError &&
        err.code === 'LLM_FAILED' &&
        err.retryable === true &&
        err.status === 502,
    );
  });

  it('maps stalled provider requests to LLM_FAILED timeout errors', async () => {
    process.env.OPENROUTER_TIMEOUT_MS = '20';
    const openRouter = createOpenRouterClient({
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'test-key',
      mode: 'live',
      fetchImpl: async (_url, init = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    });

    await assert.rejects(
      () =>
        generatePatientReply({
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
          openRouter,
        }),
      (err) =>
        err instanceof ApiError
        && err.code === 'LLM_FAILED'
        && err.retryable === true
        && err.status === 502
        && err.details?.providerCode === 'PROVIDER_TIMEOUT',
    );
  });
});

describe('POST /api/dialogue/patient-reply', () => {
  it('returns 200 PatientReplyResult for valid request', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({ openRouter: createMockOpenRouter() });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [
            {
              index: 0,
              role: 'patient',
              text: "I'm David, just diagnosed with diabetes last month.",
              createdAt: '2026-07-22T00:00:00.000Z',
            },
          ],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.tone, 'good');
      assert.equal(body.stageId, 'lifestyle_exploration');
      assert.equal(body.answerId, 'A');
      assert.equal(body.highestUnlockedOrder, 3);
      assert.equal(body.currentStageId, 'lifestyle_exploration');
      assert.equal(body.replyText, loadCaseById(CASE_ID).presetReplies.stages[0].good[0].text);
    });
  });

  it('returns VALIDATION 400 when highestUnlockedOrder is missing', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({ openRouter: createMockOpenRouter() });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION');
      assert.equal(body.retryable, false);
      assert.equal(body.details.field, 'highestUnlockedOrder');
    });
  });

  it('returns FALLBACK for invalid answer ids from the model', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({
      openRouter: {
        async chatCompletion() {
          return {
            content: JSON.stringify({
              tone: 'good',
              stageId: 'lifestyle_exploration',
              answerId: 'Z',
            }),
          };
        },
      },
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.answerId, 'FALLBACK');
      assert.equal(body.stageId, null);
      assert.equal(body.highestUnlockedOrder, 2);
    });
  });

  it('returns FALLBACK for forward skips without increasing unlock', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({
      openRouter: {
        async chatCompletion() {
          return {
            content: JSON.stringify({
              tone: 'good',
              stageId: 'healthy_coping',
              answerId: 'A',
            }),
          };
        },
      },
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [],
          studentUtterance: 'I know work stress is hard. How can you cope emotionally?',
          studentSource: 'typed',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.answerId, 'FALLBACK');
      assert.equal(body.highestUnlockedOrder, 2);
      assert.equal(body.currentStageId, 'lifestyle_exploration');
    });
  });

  it('returns LLM_BAD_JSON when model output never parses', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({
      openRouter: createMockOpenRouter({ failTimes: 5, failContent: '<<<' }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'voice',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.code, 'LLM_BAD_JSON');
      assert.equal(body.retryable, true);
    });
  });

  it('returns LLM_FAILED when provider throws', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createPatientReplyApp({
      openRouter: createMockOpenRouter({ throwProvider: true }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dialogue/patient-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          caseId: CASE_ID,
          turns: [],
          studentUtterance: EMPATHETIC,
          studentSource: 'typed',
          highestUnlockedOrder: 2,
        }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.code, 'LLM_FAILED');
      assert.equal(body.retryable, true);
    });
  });
});
