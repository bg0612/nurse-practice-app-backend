import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';
import { toPatientContext, toPatientFactCatalog } from '../models/caseContext.js';
import {
  PatientOutputValidationError,
  validatePatientOutput,
} from '../validation/patientOutputValidator.js';

const DEFAULT_PROMPTS_DIR = PROMPTS_DIR;
const PATIENT_REPLY_SYSTEM_FILE = 'patient-reply.system.md';
export const PATIENT_REPLY_TEMPERATURE = 0.2;
export const PATIENT_REPLY_MAX_RECENT_TURNS = 6;
export const PATIENT_REPLY_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'patient_reply',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['replyText', 'revealedFactIds'],
      properties: {
        replyText: { type: 'string' },
        revealedFactIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
        },
      },
    },
  },
});
export const SAFE_PATIENT_RECOVERY = Object.freeze({
  replyText: 'I am not sure about that. Could you tell me a little more?',
  revealedFactIds: [],
  recovered: true,
  recoveryCode: 'MODEL_OUTPUT_INVALID',
});
export const SAFE_PATIENT_SAFETY_RECOVERY = Object.freeze({
  replyText: 'I would rather not change my medicines without speaking to my doctor.',
  revealedFactIds: [],
  recovered: true,
  recoveryCode: 'UNSAFE_MODEL_OUTPUT',
});

function recovery(recoveryCode) {
  return { ...SAFE_PATIENT_RECOVERY, recoveryCode };
}

function readPrompt(filePath, label) {
  if (!existsSync(filePath)) {
    throw new ApiError({
      code: 'CONFIG_INVALID', message: 'Prompt configuration is missing.',
      retryable: false, status: 500, details: { field: label },
    });
  }
  return readFileSync(filePath, 'utf8').trim();
}

export function buildPatientSystemPrompt(caseConfig, promptsDir = DEFAULT_PROMPTS_DIR, { revealedFactIds = [] } = {}) {
  const base = readPrompt(path.join(promptsDir, PATIENT_REPLY_SYSTEM_FILE), PATIENT_REPLY_SYSTEM_FILE);
  return [
    base,
    '<patient_context>',
    JSON.stringify(toPatientContext(caseConfig, { revealedFactIds })),
    '</patient_context>',
  ].join('\n\n');
}

export function buildPatientReplyMessages({ committedHistory, studentUtterance, studentSource }) {
  const recentHistory = committedHistory.slice(-(PATIENT_REPLY_MAX_RECENT_TURNS * 2));
  const messages = recentHistory.map((turn) => ({
    role: turn.role === 'student' ? 'user' : 'assistant',
    content: turn.text,
  }));
  messages.push({
    role: 'user',
    content: ['<latest_student_utterance>', `source=${studentSource}`, studentUtterance, '</latest_student_utterance>'].join('\n'),
  });
  return messages;
}

function parseJsonEnvelope(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return undefined;
  let text = rawText.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Repair only harmless envelope differences; semantic output still goes through the validator. */
function locallyNormalizePatientOutput(rawText, caseConfig) {
  const parsed = parseJsonEnvelope(rawText);
  if (!parsed || typeof parsed.replyText !== 'string' || !parsed.replyText.trim()) return undefined;
  const knownFactIds = new Set(toPatientFactCatalog(caseConfig).map((fact) => fact.id));
  const revealedFactIds = Array.isArray(parsed.revealedFactIds)
    ? parsed.revealedFactIds.filter((id) => typeof id === 'string' && knownFactIds.has(id)).slice(0, 4)
    : [];
  return JSON.stringify({ replyText: parsed.replyText.trim(), revealedFactIds });
}

/** One completion; harmless envelope errors are repaired locally and semantic failures use a safe fallback. */
export async function generatePatientReply({ caseConfig, committedHistory, revealedFactIds = [], studentUtterance, studentSource, llmProvider, promptsDir }) {
  if (!llmProvider || typeof llmProvider.complete !== 'function') return recovery('PROVIDER_UNAVAILABLE');
  const baseSystemPrompt = buildPatientSystemPrompt(caseConfig, promptsDir, { revealedFactIds });
  const baseMessages = buildPatientReplyMessages({ committedHistory, studentUtterance, studentSource });
  let completion;
  try {
    completion = await llmProvider.complete({
      systemPrompt: baseSystemPrompt,
      messages: baseMessages,
      maxOutputTokens: caseConfig.runtime.responseLimits.maxOutputTokens,
      temperature: PATIENT_REPLY_TEMPERATURE,
      responseFormat: PATIENT_REPLY_RESPONSE_FORMAT,
      responseIntent: 'patient-reply',
    });
  } catch {
    return recovery('PROVIDER_ERROR');
  }

  try {
    return { ...validatePatientOutput(completion?.rawText, caseConfig), recovered: false };
  } catch (error) {
    if (!(error instanceof PatientOutputValidationError)) throw error;
    const locallyNormalized = locallyNormalizePatientOutput(completion?.rawText, caseConfig);
    if (locallyNormalized) {
      try {
        return { ...validatePatientOutput(locallyNormalized, caseConfig), recovered: false };
      } catch {
        // The local envelope repair cannot override a semantic or safety failure.
      }
    }
    if (error.codes.includes('unsafe_advice')) return { ...SAFE_PATIENT_SAFETY_RECOVERY };
    return recovery('MODEL_OUTPUT_INVALID');
  }
}

export { DEFAULT_PROMPTS_DIR, PATIENT_REPLY_SYSTEM_FILE };
