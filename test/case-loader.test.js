// backend/test/case-loader.test.js
import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import {
  CASE1_EDUCATION_TARGET_IDS,
  PRESET_STAGE_ORDERS,
  loadCaseById,
  startSession,
  validateCaseConfig,
} from '../src/models/caseModel.js';
import { ApiError } from '../src/errors/apiError.js';
import { createProviderBundle } from '../src/providers.js';

const CASE_ID = 'case-1-david-leung';
const OPENING =
  "I'm David, just diagnosed with diabetes last month. Honestly, I'm worried about how this will affect my career.";

/**
 * Minimal valid CaseConfig for mutation tests (delta shape).
 * @param {(cfg: Record<string, any>) => void} [mutate]
 */
function validCaseFixture(mutate) {
  /** @type {Record<string, any>} */
  const cfg = {
    meta: { caseId: 'fixture-case', title: 'Fixture', language: 'en' },
    patientProfile: {
      demographics: { name: 'X' },
      diagnoses: ['d'],
      medications: ['m'],
      labs: {},
      lifestyle: {},
      psychologicalProfile: {},
    },
    opening: { text: 'Hello.' },
    educationTargets: CASE1_EDUCATION_TARGET_IDS.map((id) => ({
      id,
      label: id,
      description: `${id} desc`,
    })),
    stageGuide: [
      { id: 'opening', order: 1, name: 'Opening' },
      { id: 'lifestyle_exploration', order: 2, name: 'Lifestyle Exploration' },
      { id: 'healthy_eating', order: 3, name: 'Healthy eating' },
      { id: 'being_active', order: 4, name: 'Being active' },
      { id: 'healthy_coping', order: 5, name: 'Healthy coping' },
      { id: 'problem_solving', order: 6, name: 'Problem-solving' },
      { id: 'closing_feedback', order: 7, name: 'Closing & Feedback' },
    ],
    toneGuidance: {
      goodDescription: 'Empathetic language.',
      badDescription: 'Judgmental language.',
      examples: { good: ['ok?'], bad: ['bad!'] },
    },
    contentGuidance: {
      description: 'Advice must align with education targets; wrong direction → FALLBACK.',
      correctDirections: ['Reduce refined carbs at business lunches.'],
      incorrectExamples: ['You should eat more dim sum.'],
    },
    presetReplies: {
      fallback: {
        id: 'FALLBACK',
        text: "Hmm, that doesn't quite match what my doctor and the clinic have been telling me. Could you explain that another way?",
      },
      stages: [
        {
          stageId: 'lifestyle_exploration',
          order: 2,
          good: [{ id: 'A', text: 'good-2' }],
          bad: [{ id: 'B', text: 'bad-2' }],
        },
        {
          stageId: 'healthy_eating',
          order: 3,
          good: [{ id: 'A', text: 'good-3' }],
          bad: [{ id: 'B', text: 'bad-3' }],
        },
        {
          stageId: 'being_active',
          order: 4,
          good: [{ id: 'A', text: 'good-4' }],
          bad: [{ id: 'B', text: 'bad-4' }],
        },
        {
          stageId: 'healthy_coping',
          order: 5,
          good: [{ id: 'A', text: 'good-5' }],
          bad: [{ id: 'B', text: 'bad-5' }],
        },
        {
          stageId: 'problem_solving',
          order: 6,
          good: [{ id: 'A', text: 'good-6' }],
          bad: [{ id: 'B', text: 'bad-6' }],
        },
      ],
    },
    feedback: { reflectionQuestion: 'What would you do differently?' },
  };
  if (mutate) mutate(cfg);
  return cfg;
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

describe('case config file (Case 1)', () => {
  it('loads Case 1 with required CaseConfig fields from static JSON', () => {
    const c = loadCaseById(CASE_ID);
    assert.equal(c.meta.caseId, CASE_ID);
    assert.equal(c.meta.language, 'en');
    assert.ok(c.meta.title.includes('David Leung'));
    assert.equal(c.opening.text, OPENING);
    assert.equal(c.educationTargets.length, 4);
    assert.deepEqual(
      c.educationTargets.map((t) => t.id),
      [...CASE1_EDUCATION_TARGET_IDS],
    );
    assert.equal(c.stageGuide.length, 7);
    assert.equal(c.stageGuide[0].order, 1);
    assert.equal(c.stageGuide[6].order, 7);
    assert.match(c.feedback.reflectionQuestion, /differently/i);
    assert.ok(c.patientProfile.demographics);
    assert.ok(c.patientProfile.diagnoses);
    assert.ok(c.patientProfile.medications);
    assert.ok(c.patientProfile.labs);
    assert.ok(c.patientProfile.lifestyle);
    assert.ok(c.patientProfile.psychologicalProfile);
  });

  it('loads toneGuidance + contentGuidance + presetReplies + FALLBACK from Case 1', () => {
    const c = loadCaseById(CASE_ID);
    assert.ok(c.toneGuidance);
    assert.match(c.toneGuidance.goodDescription, /empathetic|supportive/i);
    assert.match(c.toneGuidance.badDescription, /judgmental|clinical/i);
    assert.ok(c.toneGuidance.examples);
    assert.ok(Array.isArray(c.toneGuidance.examples.good));
    assert.ok(Array.isArray(c.toneGuidance.examples.bad));
    assert.equal('toneRubricRef' in c, false);

    assert.ok(c.contentGuidance);
    assert.match(c.contentGuidance.description, /educationTargets|align/i);
    assert.ok(Array.isArray(c.contentGuidance.selectionPrinciples));
    assert.ok(c.contentGuidance.selectionPrinciples.length >= 1);
    assert.ok(Array.isArray(c.contentGuidance.correctDirections));
    assert.ok(c.contentGuidance.correctDirections.length >= 1);
    assert.match(c.contentGuidance.correctDirections.join(' '), /10-minute walk|Metformin|carbohydrates/i);
    assert.ok(Array.isArray(c.contentGuidance.incorrectExamples));
    assert.ok(c.contentGuidance.incorrectExamples.length >= 1);
    assert.match(c.contentGuidance.incorrectExamples.join(' '), /dim sum/i);
    assert.match(c.contentGuidance.incorrectExamples.join(' '), /cut out all carbohydrates|Stop Metformin/i);

    assert.equal(c.opening.videoRef, '/videos/case1/opening.mp4');

    assert.equal(c.presetReplies.fallback.id, 'FALLBACK');
    assert.match(c.presetReplies.fallback.text, /doctor|clinic|explain that another way/i);

    assert.equal(c.presetReplies.stages.length, 5);
    assert.deepEqual(
      c.presetReplies.stages.map((s) => s.order),
      [...PRESET_STAGE_ORDERS],
    );
    assert.deepEqual(
      c.presetReplies.stages.map((s) => s.stageId),
      [
        'lifestyle_exploration',
        'healthy_eating',
        'being_active',
        'healthy_coping',
        'problem_solving',
      ],
    );

    for (const stage of c.presetReplies.stages) {
      assert.ok(stage.good.length >= 1, `${stage.stageId} needs good[]`);
      assert.ok(stage.bad.length >= 1, `${stage.stageId} needs bad[]`);
      for (const cand of [...stage.good, ...stage.bad]) {
        assert.ok(cand.id);
        assert.ok(cand.text && cand.text.length > 0);
      }
    }

    // Word dialogue-tree patient lines (not invented)
    assert.match(
      c.presetReplies.stages[0].good[0].text,
      /skip breakfast|dim sum/i,
    );
    assert.match(c.presetReplies.stages[4].bad[0].text, /don't have time/i);
  });

  it('transfers persona facts from the Word case (not invented)', () => {
    const c = loadCaseById(CASE_ID);
    const demo = JSON.stringify(c.patientProfile.demographics);
    assert.match(demo, /48/);
    assert.match(demo, /bank manager/i);
    assert.match(JSON.stringify(c.patientProfile.medications), /Metformin/);
    assert.match(JSON.stringify(c.patientProfile.labs), /7\.8%/);
    assert.match(JSON.stringify(c.patientProfile.lifestyle), /Dim Sum|dim sum/i);
    assert.match(
      JSON.stringify(c.patientProfile.psychologicalProfile),
      /career/i,
    );
  });
});

describe('case loader', () => {
  it('returns CASE_NOT_FOUND for unknown caseId', () => {
    assert.throws(
      () => loadCaseById('case-does-not-exist'),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CASE_NOT_FOUND' &&
        err.status === 404 &&
        err.retryable === false,
    );
  });

  it('returns CONFIG_INVALID when required fields are missing', () => {
    assert.throws(
      () => validateCaseConfig({ meta: { caseId: 'x' } }),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.status === 500 &&
        err.retryable === false,
    );
  });

  it('returns CONFIG_INVALID when toneGuidance is missing', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            delete cfg.toneGuidance;
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'toneGuidance',
    );
  });

  it('returns CONFIG_INVALID when contentGuidance is missing', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            delete cfg.contentGuidance;
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'contentGuidance',
    );
  });

  it('returns CONFIG_INVALID when contentGuidance.incorrectExamples is empty', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            cfg.contentGuidance.incorrectExamples = [];
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'contentGuidance.incorrectExamples',
    );
  });

  it('returns CONFIG_INVALID when contentGuidance.correctDirections is empty', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            cfg.contentGuidance.correctDirections = [];
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'contentGuidance.correctDirections',
    );
  });

  it('returns CONFIG_INVALID when contentGuidance.correctDirections is missing', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            delete cfg.contentGuidance.correctDirections;
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'contentGuidance.correctDirections',
    );
  });

  it('returns CONFIG_INVALID when FALLBACK is missing', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            delete cfg.presetReplies.fallback;
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        String(err.details?.field).includes('fallback'),
    );
  });

  it('returns CONFIG_INVALID when preset bank is incomplete', () => {
    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            cfg.presetReplies.stages = cfg.presetReplies.stages.slice(0, 2);
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        err.details?.field === 'presetReplies.stages',
    );

    assert.throws(
      () =>
        validateCaseConfig(
          validCaseFixture((cfg) => {
            cfg.presetReplies.stages[0].good = [];
          }),
        ),
      (err) =>
        err instanceof ApiError &&
        err.code === 'CONFIG_INVALID' &&
        String(err.details?.field).includes('.good'),
    );
  });

  it('accepts a valid delta CaseConfig fixture', () => {
    const c = validateCaseConfig(validCaseFixture());
    assert.equal(c.presetReplies.fallback.id, 'FALLBACK');
    assert.equal(c.presetReplies.stages.length, 5);
    assert.ok(c.toneGuidance.goodDescription);
    assert.ok(c.contentGuidance.description);
    assert.ok(c.contentGuidance.correctDirections.length >= 1);
    assert.ok(c.contentGuidance.incorrectExamples.length >= 1);
  });

  it('returns CONFIG_INVALID for malformed case JSON on disk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cases-'));
    writeFileSync(path.join(dir, 'bad-case.json'), '{"meta":{"caseId":"bad-case"}}');
    assert.throws(
      () => loadCaseById('bad-case', { casesDir: dir }),
      (err) => err instanceof ApiError && err.code === 'CONFIG_INVALID' && err.status === 500,
    );
  });

  it('exposes stageGuide for future use without enforcing gates', () => {
    const c = loadCaseById(CASE_ID);
    assert.equal(c.stageGuide.length, 7);
    // Loader returns stages as plain data; no gating side effects.
    const started = startSession(CASE_ID, { createSessionId: () => 'sess-1' });
    assert.equal(started.sessionId, 'sess-1');
    assert.equal(started.openingText, OPENING);
    assert.equal(started.openingVideoRef, '/videos/case1/opening.mp4');
    assert.ok(started.caseTitle);
  });
});

describe('HTTP case routes', () => {
  it('GET /api/cases/:caseId returns 200 + full case', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({ providers: createProviderBundle({ mode: 'mock', forceReload: true }) });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/cases/${CASE_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.meta.caseId, CASE_ID);
      assert.equal(body.opening.text, OPENING);
      assert.equal(body.educationTargets.length, 4);
      assert.equal(body.stageGuide.length, 7);
      assert.ok(body.toneGuidance);
      assert.equal(body.presetReplies.fallback.id, 'FALLBACK');
      assert.equal(body.presetReplies.stages.length, 5);
    });
  });

  it('GET /api/cases/:caseId returns CASE_NOT_FOUND envelope', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({ providers: createProviderBundle({ mode: 'mock', forceReload: true }) });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/cases/missing-case`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.code, 'CASE_NOT_FOUND');
      assert.equal(body.retryable, false);
      assert.ok(body.message);
    });
  });

  it('GET /api/cases/:caseId returns CONFIG_INVALID for bad JSON', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const dir = mkdtempSync(path.join(tmpdir(), 'cases-http-'));
    writeFileSync(path.join(dir, 'broken.json'), '{ not-json');
    const app = createApp({
      providers: createProviderBundle({ mode: 'mock', forceReload: true }),
      casesDir: dir,
    });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/cases/broken`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.code, 'CONFIG_INVALID');
      assert.equal(body.retryable, false);
    });
  });

  it('POST /api/session/start returns sessionId + openingText + openingVideoRef + caseTitle', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({ providers: createProviderBundle({ mode: 'mock', forceReload: true }) });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: CASE_ID }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0);
      assert.equal(body.openingText, OPENING);
      assert.equal(body.openingVideoRef, '/videos/case1/opening.mp4');
      assert.match(body.caseTitle, /David Leung/);
    });
  });

  it('POST /api/session/start returns 404 CASE_NOT_FOUND for unknown id', async () => {
    process.env.PROVIDER_MODE = 'mock';
    const app = createApp({ providers: createProviderBundle({ mode: 'mock', forceReload: true }) });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/session/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: 'nope' }),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.code, 'CASE_NOT_FOUND');
      assert.equal(body.retryable, false);
    });
  });
});
