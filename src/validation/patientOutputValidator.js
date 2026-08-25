import { toPatientFactCatalog } from '../models/caseContext.js';

const AI_IDENTITY = /\b(?:i am|i'm|as)\s+(?:an?\s+)?(?:ai|artificial intelligence|language model|chatbot|assistant)\b/i;
const NON_PATIENT_ROLE = /\b(?:as (?:your|a|the) (?:nurse|doctor|clinician|teacher|tutor|assessor|evaluator)|i am (?:your|a|the) (?:nurse|doctor|clinician|teacher|tutor|assessor|evaluator)|i (?:recommend|advise|diagnose|prescribe)|your (?:score|grade) is)\b/i;

export class PatientOutputValidationError extends Error {
  constructor(codes) {
    super('Patient model output failed validation.');
    this.name = 'PatientOutputValidationError';
    this.codes = [...new Set(codes)];
  }
}

function parseJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new PatientOutputValidationError(['invalid_schema']);
  }
  let text = rawText.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new PatientOutputValidationError(['invalid_schema']);
  }
}

/** Validate the response envelope and ensure the model remains in the configured patient role. */
export function validatePatientOutput(rawText, caseConfig) {
  const parsed = parseJson(rawText);
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PatientOutputValidationError(['invalid_schema']);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'replyText' || keys[1] !== 'revealedFactIds') {
    errors.push('invalid_schema');
  }
  const knownFactIds = new Set(toPatientFactCatalog(caseConfig).map((fact) => fact.id));
  if (!Array.isArray(parsed.revealedFactIds) || parsed.revealedFactIds.length > 4) {
    errors.push('invalid_schema');
  } else if (parsed.revealedFactIds.some((id) => typeof id !== 'string' || !knownFactIds.has(id))) {
    errors.push('unknown_fact_id');
  }
  if (typeof parsed.replyText !== 'string' || !parsed.replyText.trim()) {
    errors.push('invalid_schema');
  } else {
    const text = parsed.replyText.trim();
    if (AI_IDENTITY.test(text)) errors.push('ai_identity');
    if (NON_PATIENT_ROLE.test(text)) errors.push('role_violation');
  }
  if (errors.length) throw new PatientOutputValidationError(errors);
  return { replyText: parsed.replyText.trim(), revealedFactIds: parsed.revealedFactIds };
}
