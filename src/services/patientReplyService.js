// backend/src/services/patientReplyService.js
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadCaseById } from '../models/caseModel.js';
import { PROMPTS_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';

export const PATIENT_REPLY_TONES = Object.freeze(['good', 'bad']);

const DEFAULT_PROMPTS_DIR = PROMPTS_DIR;
const PATIENT_REPLY_SYSTEM_FILE = 'patient-reply.system.md';
const LOW_INFORMATION_ACKNOWLEDGEMENTS = new Set([
  'ok',
  'okay',
  'cool',
  'yes',
  'thanks',
  'thank you',
  'got it',
  'understood',
]);

/**
 * @typedef {object} Turn
 * @property {number} [index]
 * @property {'student' | 'patient' | 'system'} role
 * @property {string} text
 * @property {string} [createdAt]
 * @property {'good' | 'bad'} [tone]
 * @property {string|null} [stageId]
 * @property {string} [answerId]
 * @property {'voice' | 'typed'} [source]
 */

/**
 * @typedef {object} PatientReplySelection
 * @property {'good' | 'bad'} tone
 * @property {string|null} stageId
 * @property {string} answerId
 */

/**
 * @typedef {object} PatientReplyResult
 * @property {'good' | 'bad'} tone
 * @property {string|null} stageId
 * @property {string} answerId
 * @property {string} replyText
 * @property {number} highestUnlockedOrder
 * @property {string} currentStageId
 * @property {string|null} [videoRef]
 */

/**
 * @param {string} filePath
 * @param {string} label
 */
function readPromptFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      message: 'Prompt configuration is missing.',
      retryable: false,
      status: 500,
      details: { field: label, path: filePath },
    });
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      message: 'Prompt configuration could not be read.',
      retryable: false,
      status: 500,
      details: {
        field: label,
        reason: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Strip optional markdown fences and parse PatientReplySelection JSON.
 * @param {string} content
 * @returns {PatientReplySelection}
 */
export function parsePatientReplyContent(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: { reason: 'empty content' },
    });
  }

  let text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: {
        reason: err instanceof Error ? err.message : String(err),
        snippet: text.slice(0, 200),
      },
    });
  }

  return validatePatientReplyResult(parsed);
}

/**
 * @param {unknown} raw
 * @returns {PatientReplySelection}
 */
export function validatePatientReplyResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: { reason: 'result must be an object' },
    });
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  const tone = obj.tone;
  const stageId = obj.stageId;
  const answerId = obj.answerId;

  if (typeof tone !== 'string' || !PATIENT_REPLY_TONES.includes(tone)) {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: {
        reason: 'tone must be good|bad',
        tone,
      },
    });
  }

  if (stageId !== null && typeof stageId !== 'string') {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: { reason: 'stageId must be a string or null' },
    });
  }

  if (typeof answerId !== 'string' || answerId.trim() === '') {
    throw new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
      details: { reason: 'answerId must be a non-empty string' },
    });
  }

  return {
    tone: /** @type {PatientReplySelection['tone']} */ (tone),
    stageId: typeof stageId === 'string' ? stageId.trim() : null,
    answerId: answerId.trim(),
  };
}

/**
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 */
function formatToneGuidance(caseConfig) {
  const guidance = caseConfig.toneGuidance;
  const lines = [
    '## Tone guidance',
    `- good: ${guidance.goodDescription}`,
    `- bad: ${guidance.badDescription}`,
  ];
  if (guidance.examples?.good?.length) {
    lines.push('', '### Good examples');
    for (const example of guidance.examples.good) lines.push(`- ${example}`);
  }
  if (guidance.examples?.bad?.length) {
    lines.push('', '### Bad examples');
    for (const example of guidance.examples.bad) lines.push(`- ${example}`);
  }
  return lines.join('\n');
}

/**
 * Expected education directions + incorrect-advice examples for content quality checks.
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 */
function formatContentGuidance(caseConfig) {
  const lines = [
    '## Expected education directions',
    'Advice should support these directions (do not score a domain checklist here):',
  ];
  for (const target of caseConfig.educationTargets) {
    lines.push(`- ${target.label}: ${target.description}`);
  }

  const guidance = caseConfig.contentGuidance;
  lines.push('', '## Content guidance', guidance.description);

  if (guidance.selectionPrinciples?.length) {
    lines.push('', '### Selection principles');
    for (const principle of guidance.selectionPrinciples) lines.push(`- ${principle}`);
  }

  if (guidance.correctDirections?.length) {
    lines.push(
      '',
      '### Correct directions (advice must align; contradicting these → FALLBACK)',
    );
    for (const direction of guidance.correctDirections) lines.push(`- ${direction}`);
  }

  if (guidance.incorrectExamples?.length) {
    lines.push('', '### Incorrect advice examples (always FALLBACK)');
    for (const example of guidance.incorrectExamples) lines.push(`- ${example}`);
  }
  return lines.join('\n');
}

/**
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 * @param {number} highestUnlockedOrder
 */
function formatPresetCatalogue(caseConfig, highestUnlockedOrder) {
  const unlocked = [];
  const locked = [];

  for (const stage of caseConfig.presetReplies.stages) {
    const bucket = stage.order <= highestUnlockedOrder ? unlocked : locked;
    bucket.push(
      `- ${stage.stageId} (order ${stage.order})`,
      `  good: ${stage.good.map((candidate) => `${candidate.id}: ${candidate.text}`).join(' | ')}`,
      `  bad: ${stage.bad.map((candidate) => `${candidate.id}: ${candidate.text}`).join(' | ')}`,
    );
  }

  return [
    '## Preset catalogue',
    `Highest unlocked order: ${highestUnlockedOrder}`,
    '',
    '### Unlocked stages (prefer these for selection)',
    ...(unlocked.length ? unlocked : ['- none']),
    '',
    '### Locked stages (context only; server blocks forward skips)',
    ...(locked.length ? locked : ['- none']),
    '',
    `### Fallback`,
    `- FALLBACK: ${caseConfig.presetReplies.fallback.text}`,
  ].join('\n');
}

/**
 * True only for standalone acknowledgements, not longer clinically meaningful sentences.
 * @param {string} utterance
 */
export function isLowInformationAcknowledgement(utterance) {
  if (typeof utterance !== 'string') return false;
  const normalized = utterance
    .trim()
    .toLowerCase()
    .replace(/^[\s.!?,;:]+|[\s.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  return LOW_INFORMATION_ACKNOWLEDGEMENTS.has(normalized);
}

/**
 * Older clients included the latest utterance as the final history turn as well as
 * in studentUtterance. Remove only that trailing duplicate; identical earlier turns
 * remain valid conversation history.
 * @param {Turn[]} turns
 * @param {string} studentUtterance
 */
function withoutTrailingLatestUtterance(turns, studentUtterance) {
  if (!Array.isArray(turns)) return [];
  const history = [...turns];
  const last = history.at(-1);
  if (
    last?.role === 'student'
    && typeof last.text === 'string'
    && last.text.trim() === studentUtterance.trim()
  ) {
    history.pop();
  }
  return history;
}

/**
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 */
function buildStageLookups(caseConfig) {
  const byId = new Map(caseConfig.stageGuide.map((stage) => [stage.id, stage]));
  const presetById = new Map(caseConfig.presetReplies.stages.map((stage) => [stage.stageId, stage]));
  const maxPresetOrder = Math.max(...caseConfig.presetReplies.stages.map((stage) => stage.order));
  return { byId, presetById, maxPresetOrder };
}

/**
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 * @param {number} highestUnlockedOrder
 */
function getFrontierStage(caseConfig, highestUnlockedOrder) {
  const eligible = caseConfig.stageGuide
    .filter((stage) => stage.order <= highestUnlockedOrder && stage.order >= 2 && stage.order <= 6)
    .sort((a, b) => b.order - a.order);
  return eligible[0] ?? caseConfig.stageGuide.find((stage) => stage.order === 2) ?? caseConfig.stageGuide[0];
}

/**
 * @param {import('../models/caseModel.js').CaseConfig} caseConfig
 * @param {PatientReplySelection} selection
 * @param {number} highestUnlockedOrder
 * @returns {PatientReplyResult}
 */
export function resolvePatientReplySelection(caseConfig, selection, highestUnlockedOrder) {
  const { byId, presetById, maxPresetOrder } = buildStageLookups(caseConfig);
  const frontierStage = getFrontierStage(caseConfig, highestUnlockedOrder);
  const fallbackResult = {
    tone: selection.tone,
    stageId: null,
    answerId: 'FALLBACK',
    replyText: caseConfig.presetReplies.fallback.text,
    highestUnlockedOrder,
    currentStageId: frontierStage.id,
    videoRef: caseConfig.presetReplies.fallback.videoRef ?? null,
  };

  if (selection.answerId === 'FALLBACK') {
    return fallbackResult;
  }

  if (!selection.stageId) {
    return fallbackResult;
  }

  const stage = byId.get(selection.stageId);
  const presetStage = presetById.get(selection.stageId);
  if (!stage || !presetStage) {
    return fallbackResult;
  }

  if (stage.order > highestUnlockedOrder) {
    return fallbackResult;
  }

  const bank = presetStage[selection.tone];
  const candidate = bank.find((entry) => entry.id === selection.answerId);
  if (!candidate) {
    return fallbackResult;
  }

  return {
    tone: selection.tone,
    stageId: stage.id,
    answerId: candidate.id,
    replyText: candidate.text,
    highestUnlockedOrder: Math.max(highestUnlockedOrder, Math.min(stage.order + 1, maxPresetOrder)),
    currentStageId: stage.id,
    videoRef: candidate.videoRef ?? null,
  };
}

/**
 * Build system + chat messages for one patient-reply OpenRouter call.
 * @param {object} opts
 * @param {import('../models/caseModel.js').CaseConfig} opts.caseConfig
 * @param {Turn[]} opts.turns
 * @param {string} opts.studentUtterance
 * @param {'voice' | 'typed'} opts.studentSource
 * @param {number} opts.highestUnlockedOrder
 * @param {string} [opts.promptsDir]
 */
export function buildPatientReplyMessages({
  caseConfig,
  turns,
  studentUtterance,
  studentSource,
  highestUnlockedOrder,
  promptsDir = DEFAULT_PROMPTS_DIR,
}) {
  const systemTemplate = readPromptFile(
    path.join(promptsDir, PATIENT_REPLY_SYSTEM_FILE),
    'patient-reply.system.md',
  );
  const systemContent = [
    systemTemplate.trim(),
    '',
    '## Case profile (facts)',
    '```json',
    JSON.stringify(caseConfig.patientProfile, null, 2),
    '```',
    '',
    formatToneGuidance(caseConfig),
    '',
    formatContentGuidance(caseConfig),
    '',
    formatPresetCatalogue(caseConfig, highestUnlockedOrder),
  ].join('\n');

  /** @type {Array<{ role: string, content: string }>} */
  const messages = [{ role: 'system', content: systemContent }];

  const historyTurns = withoutTrailingLatestUtterance(turns, studentUtterance);
  for (const turn of historyTurns) {
    if (!turn || typeof turn.text !== 'string' || turn.text.trim() === '') continue;
    if (turn.role === 'student') {
      messages.push({ role: 'user', content: turn.text.trim() });
    } else if (turn.role === 'patient') {
      messages.push({ role: 'assistant', content: turn.text.trim() });
    }
    // system turns are omitted from the chat transcript for the LLM
  }

  messages.push({
    role: 'user',
    content: [
      `Latest student utterance (${studentSource}):`,
      studentUtterance.trim(),
      '',
      `Current highest unlocked order: ${highestUnlockedOrder}`,
      '',
      'Respond with JSON only: { "tone": "good|bad", "stageId": "stage-id-or-null", "answerId": "preset-id-or-FALLBACK" }',
    ].join('\n'),
  });

  return messages;
}

/**
 * Map thin OpenRouter/provider errors to LLM_FAILED (§6.3).
 * @param {unknown} err
 */
export function mapProviderErrorToLlmFailed(err) {
  if (err instanceof ApiError && err.code === 'LLM_BAD_JSON') {
    return err;
  }
  if (err instanceof ApiError && err.code === 'LLM_FAILED') {
    return err;
  }
  if (err instanceof ApiError && err.code.startsWith('PROVIDER_')) {
    return new ApiError({
      code: 'LLM_FAILED',
      message: 'Patient reply could not be generated. Please try again.',
      retryable: true,
      status: 502,
      details: { providerCode: err.code, providerMessage: err.message, providerDetails: err.details },
    });
  }
  if (err instanceof ApiError) {
    return err;
  }
  return new ApiError({
    code: 'LLM_FAILED',
    message: 'Patient reply could not be generated. Please try again.',
    retryable: true,
    status: 502,
    details: { reason: err instanceof Error ? err.message : String(err) },
  });
}

/**
 * One OpenRouter call (+ optional one internal retry on bad JSON) → PatientReplyResult.
 *
 * @param {object} input
 * @param {string} input.caseId
 * @param {Turn[]} input.turns
 * @param {string} input.studentUtterance
 * @param {'voice' | 'typed'} input.studentSource
 * @param {number} input.highestUnlockedOrder
 * @param {{ chatCompletion: Function, mode?: string }} input.openRouter
 * @param {string} [input.casesDir]
 * @param {string} [input.promptsDir]
 * @param {boolean} [input.retryOnBadJson=true]
 * @returns {Promise<PatientReplyResult>}
 */
export async function generatePatientReply(input) {
  const {
    caseId,
    turns,
    studentUtterance,
    studentSource,
    highestUnlockedOrder,
    openRouter,
    casesDir,
    promptsDir,
    retryOnBadJson = true,
  } = input;

  if (!Number.isInteger(highestUnlockedOrder) || highestUnlockedOrder < 1) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid patient-reply request.',
      retryable: false,
      status: 400,
      details: { field: 'highestUnlockedOrder', reason: 'must be a positive integer' },
    });
  }

  const caseConfig = loadCaseById(caseId, { casesDir });
  if (isLowInformationAcknowledgement(studentUtterance)) {
    return resolvePatientReplySelection(
      caseConfig,
      { tone: 'good', stageId: null, answerId: 'FALLBACK' },
      highestUnlockedOrder,
    );
  }

  if (!openRouter || typeof openRouter.chatCompletion !== 'function') {
    throw new ApiError({
      code: 'LLM_FAILED',
      message: 'Patient reply could not be generated. Please try again.',
      retryable: true,
      status: 502,
      details: { reason: 'openRouter client missing' },
    });
  }

  const messages = buildPatientReplyMessages({
    caseConfig,
    turns,
    studentUtterance,
    studentSource,
    highestUnlockedOrder,
    promptsDir,
  });

  const maxAttempts = retryOnBadJson ? 2 : 1;
  /** @type {ApiError | null} */
  let lastBadJson = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let completion;
    try {
      completion = await openRouter.chatCompletion({
        messages,
        temperature: 0.2,
        responseFormat: { type: 'json_object' },
      });
    } catch (err) {
      throw mapProviderErrorToLlmFailed(err);
    }

    try {
      const selection = parsePatientReplyContent(completion?.content);
      return resolvePatientReplySelection(caseConfig, selection, highestUnlockedOrder);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LLM_BAD_JSON') {
        lastBadJson = err;
        continue;
      }
      throw mapProviderErrorToLlmFailed(err);
    }
  }

  throw (
    lastBadJson ??
    new ApiError({
      code: 'LLM_BAD_JSON',
      message: 'Patient reply was not valid JSON. Please try again.',
      retryable: true,
      status: 502,
    })
  );
}

export { DEFAULT_PROMPTS_DIR, PATIENT_REPLY_SYSTEM_FILE };
