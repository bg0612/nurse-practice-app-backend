import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CASES_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';

const DEFAULT_CASES_DIR = CASES_DIR;
export const SUPPORTED_CASE_SCHEMA_VERSION = '2.0';

function configInvalid(field, reason) {
  throw new ApiError({
    code: 'CONFIG_INVALID',
    message: 'Case configuration is invalid.',
    retryable: false,
    status: 500,
    details: { field, reason },
  });
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) configInvalid(field, 'must be an object');
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || !value.trim()) configInvalid(field, 'must be a non-empty string');
}

function integer(value, field) {
  if (!Number.isInteger(value)) configInvalid(field, 'must be an integer');
}

function stringArray(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    configInvalid(field, `must be ${nonEmpty ? 'a non-empty' : 'an'} array`);
  }
  value.forEach((item, index) => string(item, `${field}[${index}]`));
}

function exact(value, expected, field) {
  if (value !== expected) configInvalid(field, `must be ${JSON.stringify(expected)}`);
}

function validatePatient(value) {
  const patient = object(value, 'patient');
  const identity = object(patient.identity, 'patient.identity');
  for (const field of ['name', 'preferredName', 'sex', 'location', 'occupation']) string(identity[field], `patient.identity.${field}`);
  integer(identity.age, 'patient.identity.age');
  stringArray(patient.background, 'patient.background', { nonEmpty: true });
  const communication = object(patient.communication, 'patient.communication');
  stringArray(communication.style, 'patient.communication.style', { nonEmpty: true });
  stringArray(communication.sensitivities, 'patient.communication.sensitivities', { nonEmpty: true });
  const clinical = object(patient.clinical, 'patient.clinical');
  for (const field of ['diagnoses', 'medications', 'observationsAndLabs', 'knownSymptoms']) {
    stringArray(clinical[field], `patient.clinical.${field}`);
  }
  stringArray(clinical.unknownFacts, 'patient.clinical.unknownFacts', { nonEmpty: true });
}

function validateDomains(value) {
  if (!Array.isArray(value) || value.length === 0) configInvalid('consultation.domains', 'must be a non-empty array');
  const ids = new Set();
  value.forEach((raw, index) => {
    const prefix = `consultation.domains[${index}]`;
    const domain = object(raw, prefix);
    string(domain.id, `${prefix}.id`);
    string(domain.label, `${prefix}.label`);
    if (ids.has(domain.id)) configInvalid(`${prefix}.id`, 'must be unique');
    ids.add(domain.id);
    const context = object(domain.patientContext, `${prefix}.patientContext`);
    for (const field of ['facts', 'concerns', 'barriers', 'beliefsAndQuestions']) {
      stringArray(context[field], `${prefix}.patientContext.${field}`);
    }
    const disclosure = object(context.disclosure, `${prefix}.patientContext.disclosure`);
    stringArray(disclosure.mayVolunteer, `${prefix}.patientContext.disclosure.mayVolunteer`);
    stringArray(disclosure.revealWhenExplored, `${prefix}.patientContext.disclosure.revealWhenExplored`);
    const objectives = object(domain.studentObjectives, `${prefix}.studentObjectives`);
    stringArray(objectives.assess, `${prefix}.studentObjectives.assess`, { nonEmpty: true });
    stringArray(objectives.supportOrEducate, `${prefix}.studentObjectives.supportOrEducate`, { nonEmpty: true });
    string(objectives.learningOutcome, `${prefix}.studentObjectives.learningOutcome`);
  });
}

function validateConsultation(value) {
  const consultation = object(value, 'consultation');
  const opening = object(consultation.opening, 'consultation.opening');
  exact(opening.studentInitiates, true, 'consultation.opening.studentInitiates');
  exact(opening.initialState, 'idle', 'consultation.opening.initialState');
  stringArray(opening.guidance, 'consultation.opening.guidance', { nonEmpty: true });
  validateDomains(consultation.domains);
}

function validateSafety(value) {
  const safety = object(value, 'safety');
  stringArray(safety.supportedDirections, 'safety.supportedDirections', { nonEmpty: true });
  stringArray(safety.unsafeAdviceExamples, 'safety.unsafeAdviceExamples', { nonEmpty: true });
}

function validateAssessment(value) {
  const assessment = object(value, 'assessment');
  if (!Array.isArray(assessment.communicationSkills) || assessment.communicationSkills.length === 0) {
    configInvalid('assessment.communicationSkills', 'must be a non-empty array');
  }
  const ids = new Set();
  assessment.communicationSkills.forEach((raw, index) => {
    const prefix = `assessment.communicationSkills[${index}]`;
    const skill = object(raw, prefix);
    for (const field of ['id', 'label', 'description']) string(skill[field], `${prefix}.${field}`);
    if (ids.has(skill.id)) configInvalid(`${prefix}.id`, 'must be unique');
    ids.add(skill.id);
  });
  stringArray(assessment.reflectionQuestions, 'assessment.reflectionQuestions', { nonEmpty: true });
}

function validateRuntime(value) {
  const runtime = object(value, 'runtime');
  const limits = object(runtime.responseLimits, 'runtime.responseLimits');
  const expectedLimits = {
    minSentences: 1,
    maxSentences: 3,
    maxCharacters: 300,
    maxOutputTokens: 512,
    maxStudentTurns: 30,
    warningAtStudentTurn: 25,
  };
  for (const [field, expected] of Object.entries(expectedLimits)) {
    integer(limits[field], `runtime.responseLimits.${field}`);
    exact(limits[field], expected, `runtime.responseLimits.${field}`);
  }
  const voice = object(runtime.voice, 'runtime.voice');
  exact(voice.provider, 'azure-speech', 'runtime.voice.provider');
  for (const field of ['voiceId', 'outputFormat']) string(voice[field], `runtime.voice.${field}`);
  if (voice.rate !== undefined) string(voice.rate, 'runtime.voice.rate');
  if (voice.pitch !== undefined) string(voice.pitch, 'runtime.voice.pitch');
  const assets = object(runtime.avatarAssets, 'runtime.avatarAssets');
  string(assets.idleVideoRef, 'runtime.avatarAssets.idleVideoRef');
  string(assets.talkingVideoRef, 'runtime.avatarAssets.talkingVideoRef');
  if (assets.posterRef !== undefined) string(assets.posterRef, 'runtime.avatarAssets.posterRef');
}

export function validateCaseConfig(raw, expectedCaseId) {
  const cfg = object(raw, 'root');
  const allowed = ['schemaVersion', 'meta', 'patient', 'consultation', 'safety', 'assessment', 'runtime'];
  const unknown = Object.keys(cfg).find((field) => !allowed.includes(field));
  if (unknown) configInvalid(unknown, 'is not allowed by schema 2.0');
  exact(cfg.schemaVersion, SUPPORTED_CASE_SCHEMA_VERSION, 'schemaVersion');
  const meta = object(cfg.meta, 'meta');
  for (const field of ['caseId', 'title', 'revision']) string(meta[field], `meta.${field}`);
  exact(meta.language, 'en', 'meta.language');
  if (expectedCaseId && meta.caseId !== expectedCaseId) {
    configInvalid('meta.caseId', `file caseId ${JSON.stringify(meta.caseId)} does not match requested ${JSON.stringify(expectedCaseId)}`);
  }
  validatePatient(cfg.patient);
  validateConsultation(cfg.consultation);
  validateSafety(cfg.safety);
  validateAssessment(cfg.assessment);
  validateRuntime(cfg.runtime);
  return cfg;
}

export function toCasePublicView(caseConfig) {
  const limits = caseConfig.runtime.responseLimits;
  const assets = caseConfig.runtime.avatarAssets;
  return {
    schemaVersion: caseConfig.schemaVersion,
    meta: structuredClone(caseConfig.meta),
    responseLimits: {
      maxStudentTurns: limits.maxStudentTurns,
      warningAtStudentTurn: limits.warningAtStudentTurn,
    },
    avatarAssets: structuredClone(assets),
  };
}

export function caseFilePath(caseId, casesDir = DEFAULT_CASES_DIR) {
  if (typeof caseId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(caseId)) {
    throw new ApiError({ code: 'CASE_NOT_FOUND', message: 'Case not found.', retryable: false, status: 404, details: { caseId } });
  }
  return path.join(casesDir, `${caseId}.json`);
}

export function loadCaseById(caseId, opts = {}) {
  const filePath = caseFilePath(caseId, opts.casesDir ?? DEFAULT_CASES_DIR);
  if (!existsSync(filePath)) {
    throw new ApiError({ code: 'CASE_NOT_FOUND', message: 'Case not found.', retryable: false, status: 404, details: { caseId } });
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ApiError({
      code: 'CONFIG_INVALID', message: 'Case configuration is invalid.', retryable: false, status: 500,
      details: { caseId, reason: error instanceof Error ? error.message : String(error) },
    });
  }
  return validateCaseConfig(parsed, caseId);
}

export function startSession(caseId, opts = {}) {
  const caseConfig = loadCaseById(caseId, { casesDir: opts.casesDir });
  return {
    sessionId: (opts.createSessionId ?? (() => randomUUID()))(),
    case: toCasePublicView(caseConfig),
    studentTurnCount: 0,
    caseConfig,
  };
}

export { DEFAULT_CASES_DIR };
