import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';
import { toFeedbackContext } from '../models/caseContext.js';

// A complete assessment contains one evidence/gap pair for every configured
// domain and communication skill. 2,600 tokens was too close to the valid
// upper bound and could truncate a detailed, otherwise-correct response.
export const FEEDBACK_MAX_OUTPUT_TOKENS = 5000;
export const DEFAULT_PROMPT_PATH = path.join(PROMPTS_DIR, 'feedback.system.md');
const REQUIRED_FEEDBACK_KEYS = new Set([
  'status', 'domains', 'communicationSkills', 'overallComment', 'improvementTips',
]);
const ASSESSMENT_STATUSES = new Set(['met', 'partial', 'missed']);
let cachedSystemPrompt;

function validation(field, reason) {
  throw new ApiError({ code: 'VALIDATION', message: 'Feedback input is invalid.', retryable: false, status: 400, details: { field, reason } });
}

function boundedString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const text = value.trim();
  if (Array.from(text).length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

function validateCriterionList(criteria, field) {
  if (!Array.isArray(criteria) || criteria.length === 0) validation(field, 'must be a non-empty array');
  const ids = new Set();
  return criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) validation(`${field}[${index}]`, 'must be an object');
    const id = typeof criterion.id === 'string' ? criterion.id.trim() : '';
    const label = typeof criterion.label === 'string' ? criterion.label.trim() : '';
    if (!id || !label) validation(`${field}[${index}]`, 'id and label are required');
    if (ids.has(id)) validation(`${field}[${index}].id`, 'must be unique');
    ids.add(id);
    return { id, label };
  });
}

function validateReflectionQuestions(value) {
  if (!Array.isArray(value) || value.length === 0) validation('assessment.reflectionQuestions', 'must be a non-empty array');
  return value.map((question, index) => boundedString(question, `reflectionQuestions[${index}]`, 500));
}

export function loadFeedbackSystemPrompt(promptPath = DEFAULT_PROMPT_PATH) {
  if (promptPath === DEFAULT_PROMPT_PATH && cachedSystemPrompt) return cachedSystemPrompt;
  const prompt = readFileSync(promptPath, 'utf8').trim();
  if (promptPath === DEFAULT_PROMPT_PATH) cachedSystemPrompt = prompt;
  return prompt;
}

function parseJsonObject(rawText) {
  let text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) throw new Error('empty response');
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Some providers occasionally add a short preface despite JSON mode.
    // Extract only a balanced top-level object; semantic/schema validation
    // below still rejects incomplete or altered assessments.
    const start = text.indexOf('{');
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index >= 0 && index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (start < 0 || end < 0) throw error;
    parsed = JSON.parse(text.slice(start, end));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
  return parsed;
}

function assessmentItemSchema(configured) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'label', 'status', 'evidence', 'gap'],
    properties: {
      id: { type: 'string', enum: configured.map((item) => item.id) },
      label: { type: 'string' },
      status: { type: 'string', enum: [...ASSESSMENT_STATUSES] },
      evidence: { type: 'string', minLength: 1, maxLength: 700 },
      gap: { anyOf: [{ type: 'string', minLength: 1, maxLength: 700 }, { type: 'null' }] },
    },
  };
}

/** Build a strict provider schema sized to the selected case. */
export function buildFeedbackResponseFormat(caseConfig) {
  const domains = validateCriterionList(caseConfig.consultation?.domains, 'consultation.domains');
  const communicationSkills = validateCriterionList(caseConfig.assessment?.communicationSkills, 'assessment.communicationSkills');
  const reflectionQuestions = validateReflectionQuestions(caseConfig.assessment?.reflectionQuestions);
  return {
    type: 'json_schema',
    json_schema: {
      name: 'session_feedback',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'domains', 'communicationSkills', 'overallComment', 'improvementTips', 'reflectionQuestions'],
        properties: {
          status: { type: 'string', const: 'complete' },
          domains: {
            type: 'array',
            minItems: domains.length,
            maxItems: domains.length,
            items: assessmentItemSchema(domains),
          },
          communicationSkills: {
            type: 'array',
            minItems: communicationSkills.length,
            maxItems: communicationSkills.length,
            items: assessmentItemSchema(communicationSkills),
          },
          overallComment: { type: 'string', minLength: 1, maxLength: 2000 },
          improvementTips: {
            type: 'array',
            minItems: 1,
            maxItems: 7,
            items: { type: 'string', minLength: 1, maxLength: 500 },
          },
          reflectionQuestions: {
            type: 'array',
            minItems: reflectionQuestions.length,
            maxItems: reflectionQuestions.length,
            items: { type: 'string' },
          },
        },
      },
    },
  };
}

function normalizeAssessments(rawItems, configured, field) {
  if (!Array.isArray(rawItems) || rawItems.length !== configured.length) throw new Error(`${field} count does not match configuration`);
  const byId = new Map();
  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field}[${index}] must be an object`);
    if (!['id', 'label', 'status', 'evidence', 'gap'].every((key) => Object.hasOwn(item, key))) {
      throw new Error(`${field}[${index}] has invalid fields`);
    }
    if (typeof item.id !== 'string' || byId.has(item.id) || !ASSESSMENT_STATUSES.has(item.status)) {
      throw new Error(`${field}[${index}] has invalid identity or status`);
    }
    const evidence = boundedString(item.evidence, `${field}[${index}].evidence`, 700);
    let gap = null;
    if (item.status === 'met') {
      if (item.gap !== null) throw new Error(`${field}[${index}].gap must be null when met`);
    } else {
      gap = boundedString(item.gap, `${field}[${index}].gap`, 700);
    }
    byId.set(item.id, { status: item.status, evidence, gap });
  });
  if (configured.some((criterion) => !byId.has(criterion.id))) throw new Error(`${field} ids do not match configuration`);
  return configured.map((criterion) => ({ ...criterion, ...byId.get(criterion.id) }));
}

/** Validate model JSON and replace model-controlled ids, labels, and reflections with case values. */
export function normalizeFeedbackResult(raw, caseConfig) {
  const context = toFeedbackContext(caseConfig);
  const domains = validateCriterionList(context.domains, 'consultation.domains');
  const communicationSkills = validateCriterionList(context.communicationSkills, 'assessment.communicationSkills');
  const reflectionQuestions = validateReflectionQuestions(context.reflectionQuestions);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('feedback must be an object');
  if ([...REQUIRED_FEEDBACK_KEYS].some((key) => !Object.hasOwn(raw, key))) {
    throw new Error('feedback is missing required fields');
  }
  if (raw.status !== 'complete') throw new Error('status must be complete');
  if (!Array.isArray(raw.improvementTips) || raw.improvementTips.length < 1 || raw.improvementTips.length > 7) {
    throw new Error('improvementTips must contain 1 to 7 items');
  }
  return {
    status: 'complete',
    domains: normalizeAssessments(raw.domains, domains, 'domains'),
    communicationSkills: normalizeAssessments(raw.communicationSkills, communicationSkills, 'communicationSkills'),
    overallComment: boundedString(raw.overallComment, 'overallComment', 2000),
    improvementTips: raw.improvementTips.map((tip, index) => boundedString(tip, `improvementTips[${index}]`, 500)),
    reflectionQuestions,
  };
}

export function buildUnavailableFeedback(caseConfig, message = 'Feedback could not be generated because of a technical error.') {
  return {
    status: 'unavailable',
    message,
    reflectionQuestions: validateReflectionQuestions(caseConfig.assessment?.reflectionQuestions),
    retryable: false,
  };
}

export function buildMockFeedbackResult({ caseConfig }) {
  return buildUnavailableFeedback(caseConfig, 'Automated assessment is unavailable in mock mode.');
}

export function buildFeedbackUserMessage({ caseConfig, turns, startedAt, endedAt }) {
  return [
    '<assessment_context>',
    JSON.stringify(toFeedbackContext(caseConfig)),
    '</assessment_context>',
    '<session_times>',
    JSON.stringify({ startedAt, endedAt }),
    '</session_times>',
    '<transcript>',
    JSON.stringify(turns),
    '</transcript>',
  ].join('\n');
}

/** One structured completion; harmless envelope differences are repaired locally. */
export async function generateFeedback({ caseConfig, turns, startedAt, endedAt, llmProvider, systemPrompt, promptPath }) {
  if (!caseConfig || typeof caseConfig !== 'object' || Array.isArray(caseConfig)) validation('caseConfig', 'must be an object');
  validateCriterionList(caseConfig.consultation?.domains, 'consultation.domains');
  validateCriterionList(caseConfig.assessment?.communicationSkills, 'assessment.communicationSkills');
  validateReflectionQuestions(caseConfig.assessment?.reflectionQuestions);
  if (!Array.isArray(turns)) validation('turns', 'must be an array');
  if (!llmProvider || typeof llmProvider.complete !== 'function') return buildUnavailableFeedback(caseConfig);

  const baseSystemPrompt = systemPrompt ?? loadFeedbackSystemPrompt(promptPath ?? DEFAULT_PROMPT_PATH);
  const baseMessage = buildFeedbackUserMessage({ caseConfig, turns, startedAt, endedAt });
  const responseFormat = buildFeedbackResponseFormat(caseConfig);
  let completion;
  try {
    completion = await llmProvider.complete({
      systemPrompt: baseSystemPrompt,
      messages: [{ role: 'user', content: baseMessage }],
      maxOutputTokens: FEEDBACK_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      responseFormat,
      responseIntent: 'feedback',
    });
  } catch {
    return buildUnavailableFeedback(caseConfig);
  }
  if (completion?.mock === true || llmProvider.mode === 'mock') return buildMockFeedbackResult({ caseConfig });
  try {
    return normalizeFeedbackResult(parseJsonObject(completion?.rawText), caseConfig);
  } catch {
    return buildUnavailableFeedback(caseConfig);
  }
}

export const runFeedbackAfterEnd = generateFeedback;
