// backend/test/feedback-service.test.js
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { CASE1_EDUCATION_TARGET_IDS, loadCaseById } from '../src/models/caseModel.js';
import { ApiError } from '../src/errors/apiError.js';
import {
  buildMockFeedbackResult,
  DEFAULT_PROMPT_PATH,
  formatTranscriptText,
  generateFeedback,
  loadFeedbackSystemPrompt,
  normalizeFeedbackResult,
  runFeedbackAfterEnd,
} from '../src/services/feedbackService.js';
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

const SAMPLE_TURNS = [
  {
    index: 0,
    role: 'patient',
    text: "I'm David, just diagnosed with diabetes last month.",
    createdAt: '2026-07-22T08:00:00.000Z',
  },
  {
    index: 1,
    role: 'student',
    text: 'Try vegetables and protein first, then carbs. Also swap white rice at dim sum lunches, take a brisk walk after lunch, and treat burnout as manageable.',
    createdAt: '2026-07-22T08:01:00.000Z',
    source: 'typed',
  },
  {
    index: 2,
    role: 'patient',
    text: 'That sounds doable for my banking schedule.',
    createdAt: '2026-07-22T08:01:30.000Z',
    toneSeverity: 'none',
  },
];

describe('feedback prompt asset (M6)', () => {
  it('loads feedback.system.md independently of patient-reply prompt', () => {
    assert.equal(existsSync(DEFAULT_PROMPT_PATH), true);
    const text = loadFeedbackSystemPrompt();
    assert.match(text, /No points|no points|No points\/scores/i);
    assert.match(text, /domain/i);
    assert.match(text, /tone/i);
    assert.doesNotMatch(text, /patient-reply\.system/);
  });
});

describe('generateFeedback', () => {
  it('normalizes LLM JSON into FeedbackResult with four domains and case reflection', async () => {
    const caseConfig = loadCaseById(CASE_ID);
    const llmPayload = {
      domains: [
        { id: 'meal_sequencing', label: 'Meal sequencing', covered: true },
        { id: 'carbohydrate_identification', label: 'Carbohydrate identification', covered: true },
        { id: 'post_meal_glucose_reduction', label: 'Reduce glucose level after meal', covered: false },
        { id: 'burnout_coping', label: 'Addressing burnout (coping)', covered: true },
      ],
      toneSummary: 'Supportive overall with one mild clinical moment.',
      overallComment: 'Solid coverage of diet and coping; add a post-lunch walk plan.',
      improvementTips: ['Ask about walking after lunch.', 'Check understanding of carb swaps.'],
      // LLM must not win over case config for reflection
      reflectionQuestion: 'LLM should not override this',
    };

    const openRouter = {
      mode: 'live',
      async chatCompletion() {
        return { content: JSON.stringify(llmPayload), model: 'mock', mock: false };
      },
    };

    const result = await generateFeedback({
      caseConfig,
      turns: SAMPLE_TURNS,
      openRouter,
    });

    assert.equal(result.domains.length, 4);
    assert.deepEqual(
      result.domains.map((d) => d.id),
      [...CASE1_EDUCATION_TARGET_IDS],
    );
    assert.equal(result.domains[2].covered, false);
    assert.equal(result.toneSummary, llmPayload.toneSummary);
    assert.equal(result.overallComment, llmPayload.overallComment);
    assert.deepEqual(result.improvementTips, llmPayload.improvementTips);
    assert.equal(result.reflectionQuestion, caseConfig.feedback.reflectionQuestion);
    assert.doesNotMatch(JSON.stringify(result), /\bpoints?\b/i);
  });

  it('maps provider failures to FEEDBACK_LLM_FAILED (retryable)', async () => {
    const caseConfig = loadCaseById(CASE_ID);
    const openRouter = {
      mode: 'live',
      async chatCompletion() {
        throw new ApiError({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'down',
          retryable: true,
          status: 502,
        });
      },
    };

    await assert.rejects(
      () => generateFeedback({ caseConfig, turns: SAMPLE_TURNS, openRouter }),
      (err) =>
        err instanceof ApiError &&
        err.code === 'FEEDBACK_LLM_FAILED' &&
        err.retryable === true &&
        err.status === 502,
    );
  });

  it('maps invalid LLM JSON to FEEDBACK_LLM_FAILED', async () => {
    const caseConfig = loadCaseById(CASE_ID);
    const openRouter = {
      mode: 'live',
      async chatCompletion() {
        return { content: 'not-json{{{', model: 'x', mock: false };
      },
    };

    await assert.rejects(
      () => generateFeedback({ caseConfig, turns: SAMPLE_TURNS, openRouter }),
      (err) => err instanceof ApiError && err.code === 'FEEDBACK_LLM_FAILED',
    );
  });

  it('uses mock synthesis with default OpenRouter mock client', async () => {
    const caseConfig = loadCaseById(CASE_ID);
    const providers = createProviderBundle({ mode: 'mock' });
    const result = await generateFeedback({
      caseConfig,
      turns: SAMPLE_TURNS,
      openRouter: providers.openRouter,
    });

    assert.equal(result.domains.length, 4);
    assert.ok(result.domains.every((d) => typeof d.covered === 'boolean'));
    assert.ok(result.toneSummary.length > 0);
    assert.ok(result.overallComment.length > 0);
    assert.ok(Array.isArray(result.improvementTips) && result.improvementTips.length >= 1);
    assert.equal(result.reflectionQuestion, caseConfig.feedback.reflectionQuestion);
    // Heuristic should mark several domains covered from SAMPLE_TURNS
    assert.ok(result.domains.filter((d) => d.covered).length >= 2);
  });

  it('runFeedbackAfterEnd delegates to generateFeedback', async () => {
    const caseConfig = loadCaseById(CASE_ID);
    const openRouter = {
      mode: 'live',
      async chatCompletion() {
        return {
          content: JSON.stringify({
            domains: caseConfig.educationTargets.map((t) => ({
              id: t.id,
              label: t.label,
              covered: true,
            })),
            toneSummary: 'Warm and collaborative.',
            overallComment: 'All domains addressed.',
            improvementTips: ['Keep using teach-back.'],
          }),
          model: 'x',
          mock: false,
        };
      },
    };

    const result = await runFeedbackAfterEnd({
      caseConfig,
      turns: SAMPLE_TURNS,
      openRouter,
    });
    assert.equal(result.domains.every((d) => d.covered), true);
  });

  it('rejects missing education targets with VALIDATION', async () => {
    const openRouter = {
      mode: 'live',
      async chatCompletion() {
        return { content: '{}', model: 'x', mock: false };
      },
    };
    await assert.rejects(
      () =>
        generateFeedback({
          educationTargets: [{ id: 'a', label: 'A' }],
          reflectionQuestion: 'Q?',
          turns: SAMPLE_TURNS,
          openRouter,
        }),
      (err) => err instanceof ApiError && err.code === 'VALIDATION',
    );
  });
});

describe('normalizeFeedbackResult / helpers', () => {
  it('fills domain labels from case targets and forces reflection from case', () => {
    const caseConfig = loadCaseById(CASE_ID);
    const normalized = normalizeFeedbackResult(
      {
        domains: [{ id: 'meal_sequencing', covered: true }],
        toneSummary: 'ok',
        overallComment: 'ok',
        improvementTips: ['tip'],
      },
      caseConfig.educationTargets,
      caseConfig.feedback.reflectionQuestion,
    );
    assert.equal(normalized.domains.length, 4);
    assert.equal(normalized.domains[0].covered, true);
    assert.equal(normalized.domains[0].label, caseConfig.educationTargets[0].label);
    assert.equal(normalized.domains[1].covered, false);
    assert.equal(normalized.reflectionQuestion, caseConfig.feedback.reflectionQuestion);
  });

  it('formatTranscriptText includes roles', () => {
    const text = formatTranscriptText(SAMPLE_TURNS);
    assert.match(text, /\[PATIENT\]/);
    assert.match(text, /\[STUDENT\]/);
  });

  it('buildMockFeedbackResult returns four blocks without scores', () => {
    const caseConfig = loadCaseById(CASE_ID);
    const mock = buildMockFeedbackResult({
      educationTargets: caseConfig.educationTargets,
      reflectionQuestion: caseConfig.feedback.reflectionQuestion,
      transcriptText: formatTranscriptText(SAMPLE_TURNS),
    });
    assert.equal(mock.domains.length, 4);
    assert.ok(!('score' in mock));
    assert.ok(!('points' in mock));
  });
});

describe('POST /api/session/end feedback wiring', () => {
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

  it('returns FeedbackResult via polling (mock OpenRouter)', async () => {
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock' }),
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-fb-1',
          caseId: CASE_ID,
          startedAt: '2026-07-22T08:00:00.000Z',
          endedAt: '2026-07-22T08:15:00.000Z',
          turns: SAMPLE_TURNS,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.feedbackStatus, 'generating');

      const feedbackBody = await pollFeedback(port, 'sess-fb-1');
      assert.equal(feedbackBody.status, 'ready');
      assert.equal(feedbackBody.feedback.domains.length, 4);
      assert.deepEqual(
        feedbackBody.feedback.domains.map((d) => d.id),
        [...CASE1_EDUCATION_TARGET_IDS],
      );
      assert.ok(feedbackBody.feedback.toneSummary);
      assert.ok(feedbackBody.feedback.overallComment);
      assert.ok(Array.isArray(feedbackBody.feedback.improvementTips));
      assert.match(feedbackBody.feedback.reflectionQuestion, /differently/i);
    });
  });

  it('reports feedback error via polling when feedback inject fails', async () => {
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock' }),
      generateFeedbackFn: async () => {
        throw new ApiError({
          code: 'FEEDBACK_LLM_FAILED',
          message: 'boom',
          retryable: true,
          status: 502,
        });
      },
    });

    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-fb-fail',
          caseId: CASE_ID,
          startedAt: '2026-07-22T08:00:00.000Z',
          endedAt: '2026-07-22T08:15:00.000Z',
          turns: SAMPLE_TURNS,
        }),
      });
      assert.equal(res.status, 200);

      const feedbackBody = await pollFeedback(port, 'sess-fb-fail');
      assert.equal(feedbackBody.status, 'error');
    });
  });
});
