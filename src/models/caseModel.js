// backend/src/models/caseModel.js
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CASES_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';

const DEFAULT_CASES_DIR = CASES_DIR;

/** Stage orders that must carry preset reply banks (Stages 2–6). */
export const PRESET_STAGE_ORDERS = Object.freeze([2, 3, 4, 5, 6]);

/**
 * @typedef {object} PresetCandidate
 * @property {string} id
 * @property {string} text
 * @property {string|null} [videoRef]
 */

/**
 * @typedef {object} CaseConfig
 * @property {{ caseId: string, title: string, language: string }} meta
 * @property {object} patientProfile
 * @property {{ text: string, videoRef?: string|null }} opening
 * @property {{ id: string, label: string, description: string }[]} educationTargets
 * @property {{ id: string, order: number, name: string }[]} stageGuide
 * @property {{ goodDescription: string, badDescription: string, examples?: object }} toneGuidance
 * @property {{
 *   description: string,
 *   selectionPrinciples?: string[],
 *   correctDirections: string[],
 *   incorrectExamples: string[]
 * }} contentGuidance
 * @property {{
 *   fallback: { id: string, text: string, videoRef?: string|null },
 *   stages: { stageId: string, order: number, good: PresetCandidate[], bad: PresetCandidate[] }[]
 * }} presetReplies
 * @property {{ reflectionQuestion: string, templates?: object }} feedback
 */

/** Case 1 education target ids (REQUIREMENTS C.6 / DETAILED_DESIGN §5.1). */
export const CASE1_EDUCATION_TARGET_IDS = Object.freeze([
  'meal_sequencing',
  'carbohydrate_identification',
  'post_meal_glucose_reduction',
  'burnout_coping',
]);

/**
 * @param {string} field
 * @param {string} reason
 * @returns {never}
 */
function configInvalid(field, reason) {
  throw new ApiError({
    code: 'CONFIG_INVALID',
    message: 'Case configuration is invalid.',
    retryable: false,
    status: 500,
    details: { field, reason },
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    configInvalid(label, 'missing or empty string');
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configInvalid(label, 'must be an object');
  }
}

/**
 * Optional Phase 2 videoRef: omit, null, or non-empty string.
 * @param {unknown} value
 * @param {string} label
 */
function assertOptionalVideoRef(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    configInvalid(label, 'must be a string, null, or omitted');
  }
}

/**
 * @param {unknown} candidate
 * @param {string} label
 */
function validatePresetCandidate(candidate, label) {
  requireObject(candidate, label);
  const c = /** @type {Record<string, any>} */ (candidate);
  requireNonEmptyString(c.id, `${label}.id`);
  requireNonEmptyString(c.text, `${label}.text`);
  assertOptionalVideoRef(c.videoRef, `${label}.videoRef`);
}

/**
 * @param {unknown} bank
 * @param {string} label
 */
function validateCandidateBank(bank, label) {
  if (!Array.isArray(bank) || bank.length < 1) {
    configInvalid(label, 'must be a non-empty array');
  }
  for (let i = 0; i < bank.length; i += 1) {
    validatePresetCandidate(bank[i], `${label}[${i}]`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length < 1) {
    configInvalid(label, 'must be a non-empty array');
  }
  for (let i = 0; i < value.length; i += 1) {
    requireNonEmptyString(value[i], `${label}[${i}]`);
  }
}

/**
 * Validate contentGuidance (advice-direction checks for patient-reply selection).
 * @param {Record<string, any>} cfg
 */
function validateContentGuidance(cfg) {
  requireObject(cfg.contentGuidance, 'contentGuidance');
  requireNonEmptyString(cfg.contentGuidance.description, 'contentGuidance.description');
  requireNonEmptyStringArray(
    cfg.contentGuidance.correctDirections,
    'contentGuidance.correctDirections',
  );
  requireNonEmptyStringArray(
    cfg.contentGuidance.incorrectExamples,
    'contentGuidance.incorrectExamples',
  );
  if (cfg.contentGuidance.selectionPrinciples !== undefined) {
    requireNonEmptyStringArray(
      cfg.contentGuidance.selectionPrinciples,
      'contentGuidance.selectionPrinciples',
    );
  }
}

/**
 * Validate toneGuidance + presetReplies (delta 2026-07-28). Does not enforce unlock gates.
 * @param {Record<string, any>} cfg
 * @param {{ id: string, order: number }[]} stageGuide
 */
function validateToneAndPresets(cfg, stageGuide) {
  requireObject(cfg.toneGuidance, 'toneGuidance');
  requireNonEmptyString(cfg.toneGuidance.goodDescription, 'toneGuidance.goodDescription');
  requireNonEmptyString(cfg.toneGuidance.badDescription, 'toneGuidance.badDescription');

  validateContentGuidance(cfg);

  requireObject(cfg.presetReplies, 'presetReplies');
  requireObject(cfg.presetReplies.fallback, 'presetReplies.fallback');
  requireNonEmptyString(cfg.presetReplies.fallback.id, 'presetReplies.fallback.id');
  if (cfg.presetReplies.fallback.id !== 'FALLBACK') {
    configInvalid('presetReplies.fallback.id', 'must be "FALLBACK"');
  }
  requireNonEmptyString(cfg.presetReplies.fallback.text, 'presetReplies.fallback.text');
  assertOptionalVideoRef(
    cfg.presetReplies.fallback.videoRef,
    'presetReplies.fallback.videoRef',
  );

  if (!Array.isArray(cfg.presetReplies.stages)) {
    configInvalid('presetReplies.stages', 'must be an array');
  }

  const expected = stageGuide
    .filter((s) => PRESET_STAGE_ORDERS.includes(s.order))
    .sort((a, b) => a.order - b.order);

  if (cfg.presetReplies.stages.length !== expected.length) {
    configInvalid(
      'presetReplies.stages',
      `must include exactly ${expected.length} stages (orders ${PRESET_STAGE_ORDERS.join(', ')})`,
    );
  }

  const seenOrders = new Set();
  const seenStageIds = new Set();

  for (let i = 0; i < cfg.presetReplies.stages.length; i += 1) {
    const stage = cfg.presetReplies.stages[i];
    const label = `presetReplies.stages[${i}]`;
    requireObject(stage, label);
    requireNonEmptyString(stage.stageId, `${label}.stageId`);
    if (typeof stage.order !== 'number' || !Number.isInteger(stage.order)) {
      configInvalid(`${label}.order`, 'must be an integer');
    }
    if (!PRESET_STAGE_ORDERS.includes(stage.order)) {
      configInvalid(`${label}.order`, `must be one of ${PRESET_STAGE_ORDERS.join(', ')}`);
    }
    if (seenOrders.has(stage.order)) {
      configInvalid(`${label}.order`, `duplicate order ${stage.order}`);
    }
    if (seenStageIds.has(stage.stageId)) {
      configInvalid(`${label}.stageId`, `duplicate stageId "${stage.stageId}"`);
    }
    seenOrders.add(stage.order);
    seenStageIds.add(stage.stageId);

    const guide = expected.find((s) => s.order === stage.order);
    if (!guide) {
      configInvalid(`${label}.order`, `no matching stageGuide entry for order ${stage.order}`);
    }
    if (guide.id !== stage.stageId) {
      configInvalid(
        `${label}.stageId`,
        `must match stageGuide id "${guide.id}" for order ${stage.order}`,
      );
    }

    validateCandidateBank(stage.good, `${label}.good`);
    validateCandidateBank(stage.bad, `${label}.bad`);
  }
}

/**
 * Validate CaseConfig required fields (§5.1).
 * @param {unknown} raw
 * @param {string} [expectedCaseId]
 * @returns {CaseConfig}
 */
export function validateCaseConfig(raw, expectedCaseId) {
  requireObject(raw, 'root');
  const cfg = /** @type {Record<string, any>} */ (raw);

  requireObject(cfg.meta, 'meta');
  requireNonEmptyString(cfg.meta.caseId, 'meta.caseId');
  requireNonEmptyString(cfg.meta.title, 'meta.title');
  requireNonEmptyString(cfg.meta.language, 'meta.language');

  if (expectedCaseId && cfg.meta.caseId !== expectedCaseId) {
    configInvalid(
      'meta.caseId',
      `file caseId "${cfg.meta.caseId}" does not match requested "${expectedCaseId}"`,
    );
  }

  requireObject(cfg.patientProfile, 'patientProfile');
  for (const key of [
    'demographics',
    'diagnoses',
    'medications',
    'labs',
    'lifestyle',
    'psychologicalProfile',
  ]) {
    if (cfg.patientProfile[key] === undefined || cfg.patientProfile[key] === null) {
      configInvalid(`patientProfile.${key}`, 'required');
    }
  }

  requireObject(cfg.opening, 'opening');
  requireNonEmptyString(cfg.opening.text, 'opening.text');
  assertOptionalVideoRef(cfg.opening.videoRef, 'opening.videoRef');

  if (!Array.isArray(cfg.educationTargets) || cfg.educationTargets.length !== 4) {
    configInvalid('educationTargets', 'must be an array of exactly 4 items');
  }

  const ids = [];
  for (let i = 0; i < cfg.educationTargets.length; i += 1) {
    const t = cfg.educationTargets[i];
    requireObject(t, `educationTargets[${i}]`);
    requireNonEmptyString(t.id, `educationTargets[${i}].id`);
    requireNonEmptyString(t.label, `educationTargets[${i}].label`);
    requireNonEmptyString(t.description, `educationTargets[${i}].description`);
    ids.push(t.id);
  }

  for (const requiredId of CASE1_EDUCATION_TARGET_IDS) {
    if (!ids.includes(requiredId)) {
      configInvalid('educationTargets', `missing required id "${requiredId}"`);
    }
  }

  if (!Array.isArray(cfg.stageGuide) || cfg.stageGuide.length !== 7) {
    configInvalid('stageGuide', 'must be an array of exactly 7 stages');
  }

  for (let i = 0; i < cfg.stageGuide.length; i += 1) {
    const s = cfg.stageGuide[i];
    requireObject(s, `stageGuide[${i}]`);
    requireNonEmptyString(s.id, `stageGuide[${i}].id`);
    requireNonEmptyString(s.name, `stageGuide[${i}].name`);
    if (typeof s.order !== 'number' || !Number.isInteger(s.order)) {
      configInvalid(`stageGuide[${i}].order`, 'must be an integer');
    }
  }

  validateToneAndPresets(cfg, cfg.stageGuide);

  requireObject(cfg.feedback, 'feedback');
  requireNonEmptyString(cfg.feedback.reflectionQuestion, 'feedback.reflectionQuestion');

  return /** @type {CaseConfig} */ (cfg);
}

/**
 * Resolve case JSON path for a caseId (plain JSON only — no Word/PDF parsing).
 * @param {string} caseId
 * @param {string} [casesDir]
 */
export function caseFilePath(caseId, casesDir = DEFAULT_CASES_DIR) {
  // Only allow simple ids so path traversal cannot leave the cases directory.
  if (typeof caseId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(caseId)) {
    throw new ApiError({
      code: 'CASE_NOT_FOUND',
      message: 'Case not found.',
      retryable: false,
      status: 404,
      details: { caseId },
    });
  }
  return path.join(casesDir, `${caseId}.json`);
}

/**
 * Load and validate a case by caseId from config/cases/.
 * @param {string} caseId
 * @param {{ casesDir?: string }} [opts]
 * @returns {CaseConfig}
 */
export function loadCaseById(caseId, opts = {}) {
  const casesDir = opts.casesDir ?? DEFAULT_CASES_DIR;
  const filePath = caseFilePath(caseId, casesDir);

  if (!existsSync(filePath)) {
    throw new ApiError({
      code: 'CASE_NOT_FOUND',
      message: 'Case not found.',
      retryable: false,
      status: 404,
      details: { caseId },
    });
  }

  let rawText;
  try {
    rawText = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      message: 'Case configuration is invalid.',
      retryable: false,
      status: 500,
      details: {
        caseId,
        reason: err instanceof Error ? err.message : String(err),
      },
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      message: 'Case configuration is invalid.',
      retryable: false,
      status: 500,
      details: {
        caseId,
        reason: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return validateCaseConfig(parsed, caseId);
}

/**
 * Start a practice session for a case (validates load; does not enforce stages).
 * @param {string} caseId
 * @param {{ casesDir?: string, createSessionId?: () => string }} [opts]
 */
export function startSession(caseId, opts = {}) {
  const caseConfig = loadCaseById(caseId, { casesDir: opts.casesDir });
  const createSessionId = opts.createSessionId ?? (() => randomUUID());
  return {
    sessionId: createSessionId(),
    openingText: caseConfig.opening.text,
    openingVideoRef: caseConfig.opening.videoRef ?? null,
    caseTitle: caseConfig.meta.title,
  };
}

export { DEFAULT_CASES_DIR };
