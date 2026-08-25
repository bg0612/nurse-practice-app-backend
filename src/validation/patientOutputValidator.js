import { toPatientFactCatalog } from '../models/caseContext.js';

const NON_ENGLISH_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Thai}]/u;
const AI_IDENTITY = /\b(?:i am|i'm|as)\s+(?:an?\s+)?(?:ai|artificial intelligence|language model|chatbot|assistant)\b/i;
const NON_PATIENT_ROLE = /\b(?:as (?:your|a|the) (?:nurse|doctor|clinician|teacher|tutor|assessor|evaluator)|i am (?:your|a|the) (?:nurse|doctor|clinician|teacher|tutor|assessor|evaluator)|i (?:recommend|advise|diagnose|prescribe)|your (?:score|grade) is)\b/i;
const PROMPT_DISCLOSURE = /\b(?:system prompt|developer message|hidden (?:prompt|instruction|rule|policy)|internal (?:prompt|instruction|rule|policy)|my instructions (?:say|are)|prompt says|policy says)\b/i;
const UNSAFE_CLINICAL_INSTRUCTION = /\b(?:you should|you must|i recommend|my advice is to)\b[^.!?]{0,100}\b(?:stop|start|double|halve|increase|decrease|skip|avoid|eliminate|take)\b/i;
const OBVIOUS_FABRICATION = /\b(?:i (?:take|use|inject|was prescribed|have|was diagnosed with|am allergic to)|my (?:allergy|allergies|family history|blood pressure|hba1c|glucose|cholesterol|dose|medication) (?:is|are))\b/i;
const CLINICAL_TERMS = /\b(?:insulin|metformin|norvasc|lipitor|penicillin|asthma|cancer|allerg(?:y|ic|ies)|smok(?:e|ing)|alcohol|hba1c|glucose|cholesterol|kidney|renal|heart disease|stroke|infection|fever|chest pain|dizzi(?:ness|y)|nausea|headache|numbness|blurred vision|\d+(?:\.\d+)?)\b/g;
const COMMON_ENGLISH = new Set([
  'i', 'me', 'my', 'we', 'the', 'a', 'an', 'am', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'do', 'does', 'did', 'not', 'this', 'that', 'it', 'to',
  'of', 'and', 'but', 'with', 'about', 'feel', 'feeling', 'worry', 'worried',
  'know', 'remember', 'told', 'could', 'would', 'can', 'cannot', 'what', 'how',
  'why', 'when', 'where', 'hello', 'thanks', 'please', 'okay', 'yes', 'sure',
  'doctor', 'work',
]);

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

function normalizedCaseText(caseConfig) {
  return JSON.stringify({
    patient: caseConfig.patient,
    domains: caseConfig.consultation?.domains?.map((domain) => domain.patientContext),
  }).toLowerCase();
}

function hasObviousFabrication(replyText, caseConfig) {
  if (!OBVIOUS_FABRICATION.test(replyText)) return false;
  const caseText = normalizedCaseText(caseConfig);
  const claimTerms = replyText.toLowerCase().match(CLINICAL_TERMS) ?? [];
  return claimTerms.some((term) => !caseText.includes(term));
}

function looksEnglish(text) {
  if (NON_ENGLISH_SCRIPT.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  return words.length > 0 && words.some((word) => COMMON_ENGLISH.has(word) || /n't$/.test(word));
}

/** Parse and conservatively validate the model's patient-visible result. */
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
    if (!looksEnglish(text)) errors.push('non_english');
    if (AI_IDENTITY.test(text)) errors.push('ai_identity');
    if (NON_PATIENT_ROLE.test(text)) errors.push('role_violation');
    if (PROMPT_DISCLOSURE.test(text)) errors.push('prompt_disclosure');
    if (UNSAFE_CLINICAL_INSTRUCTION.test(text)) errors.push('unsafe_advice');
    if (hasObviousFabrication(text, caseConfig)) errors.push('clinical_fabrication');
  }
  if (errors.length) throw new PatientOutputValidationError(errors);
  return { replyText: parsed.replyText.trim(), revealedFactIds: parsed.revealedFactIds };
}
