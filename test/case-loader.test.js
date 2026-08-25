import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import express from 'express';
import {
  SUPPORTED_CASE_SCHEMA_VERSION,
  loadCaseById,
  startSession,
  toCasePublicView,
  validateCaseConfig,
} from '../src/models/caseModel.js';
import { toFeedbackContext, toPatientContext } from '../src/models/caseContext.js';
import { ApiError } from '../src/errors/apiError.js';
import { createCaseRoutes } from '../src/routes/cases.js';

const CASE_ID = 'case-1-david-leung';
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function validCaseFixture(mutate) {
  const cfg = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'case-2-maya-chen.json'), 'utf8'));
  if (mutate) mutate(cfg);
  return cfg;
}

function assertConfigInvalid(fn, field) {
  assert.throws(fn, (error) => error instanceof ApiError && error.code === 'CONFIG_INVALID' && error.details?.field === field);
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { await fn(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

describe('CaseConfig 2.0', () => {
  it('loads the complete PDF-aligned David case', () => {
    const cfg = loadCaseById(CASE_ID);
    assert.equal(cfg.schemaVersion, SUPPORTED_CASE_SCHEMA_VERSION);
    assert.equal(cfg.patient.identity.name, 'Mr. David Leung');
    assert.match(JSON.stringify(cfg.patient.clinical), /Metformin|7\.8%/);
    assert.deepEqual(cfg.consultation.domains.map((domain) => domain.id), [
      'healthy_coping', 'healthy_eating', 'being_active', 'taking_medication',
      'monitoring', 'reducing_risk', 'problem_solving',
    ]);
    assert.equal(cfg.assessment.communicationSkills.length, 5);
    assert.equal(cfg.assessment.reflectionQuestions.length, 3);
    assert.equal(cfg.runtime.voice.voiceId, 'en-HK-SamNeural');
  });

  it('loads a different patient and target count without case-specific code', () => {
    const cfg = loadCaseById('case-2-maya-chen', { casesDir: FIXTURES_DIR });
    assert.equal(cfg.patient.identity.name, 'Maya Chen');
    assert.equal(cfg.consultation.domains.length, 1);
    assert.equal(cfg.assessment.communicationSkills.length, 1);
    assert.equal(cfg.runtime.voice.voiceId, 'en-US-JennyNeural');
  });

  it('contains no stages, preset replies, answer ids, or fixed opening', () => {
    const cfg = loadCaseById(CASE_ID);
    const text = JSON.stringify(cfg);
    for (const forbidden of ['stageGuide', 'presetReplies', 'answerId']) assert.equal(text.includes(forbidden), false);
    assert.equal(cfg.consultation.opening.studentInitiates, true);
    assert.equal(cfg.consultation.opening.initialState, 'idle');
  });

  it('rejects unsupported, missing, and malformed required fields', () => {
    assertConfigInvalid(() => validateCaseConfig(validCaseFixture((cfg) => { cfg.schemaVersion = '1.0'; })), 'schemaVersion');
    assertConfigInvalid(() => validateCaseConfig(validCaseFixture((cfg) => { delete cfg.schemaVersion; })), 'schemaVersion');
    assertConfigInvalid(() => validateCaseConfig(validCaseFixture((cfg) => { delete cfg.patient.identity.name; })), 'patient.identity.name');
    assertConfigInvalid(() => validateCaseConfig(validCaseFixture((cfg) => { delete cfg.runtime.responseLimits.maxOutputTokens; })), 'runtime.responseLimits.maxOutputTokens');
    assertConfigInvalid(() => validateCaseConfig(validCaseFixture((cfg) => { delete cfg.consultation.domains[0].studentObjectives; })), 'consultation.domains[0].studentObjectives');
  });

  it('returns role-specific projections without irrelevant configuration', () => {
    const cfg = loadCaseById(CASE_ID);
    const patient = toPatientContext(cfg);
    const feedback = toFeedbackContext(cfg);
    assert.match(JSON.stringify(patient), /Rarely checks blood glucose/);
    assert.equal(JSON.stringify(patient).includes('studentObjectives'), false);
    assert.equal(JSON.stringify(patient).includes('communicationSkills'), false);
    assert.equal(JSON.stringify(patient).includes('voiceId'), false);
    assert.match(JSON.stringify(feedback), /learningOutcome|communicationSkills|reflectionQuestions/);
    assert.equal(JSON.stringify(feedback).includes('voiceId'), false);
    assert.equal(JSON.stringify(feedback).includes('maxStudentTurns'), false);
  });

  it('returns CASE_NOT_FOUND for unsafe ids and CONFIG_INVALID for malformed JSON', () => {
    assert.throws(() => loadCaseById('../case-1-david-leung'), (error) => error.code === 'CASE_NOT_FOUND');
    const dir = mkdtempSync(path.join(tmpdir(), 'cases-'));
    writeFileSync(path.join(dir, 'broken.json'), '{ not-json');
    assert.throws(() => loadCaseById('broken', { casesDir: dir }), (error) => error.code === 'CONFIG_INVALID');
  });
});

describe('public case contracts', () => {
  it('exposes only browser-safe runtime data', () => {
    const view = toCasePublicView(loadCaseById(CASE_ID));
    assert.deepEqual(Object.keys(view), ['schemaVersion', 'meta', 'responseLimits', 'avatarAssets']);
    assert.equal(JSON.stringify(view).includes('Metformin'), false);
    assert.equal(JSON.stringify(view).includes('reflectionQuestions'), false);
  });

  it('starts silently and routes return only the public subset', async () => {
    const result = startSession(CASE_ID, { createSessionId: () => 'sess-1' });
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.studentTurnCount, 0);
    assert.equal('openingText' in result, false);
    const app = express();
    app.use(express.json());
    app.use(createCaseRoutes());
    await withServer(app, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/cases/${CASE_ID}`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal('patient' in body, false);
      assert.equal(body.meta.caseId, CASE_ID);
    });
  });
});
