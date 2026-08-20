// backend/src/services/feedbackService.js
/**
 * M6 — one-shot post-session OpenRouter feedback analysis.
 * Separate from M5 patient-reply prompts; text only (no TTS).
 *
 * Stable End-route contract (M8):
 *   generateFeedback({ caseConfig, turns, openRouter })
 * Also accepts explicit educationTargets / reflectionQuestion / turnsOrTranscript for tests.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../config/paths.js';
import { ApiError } from '../errors/apiError.js';

const DEFAULT_PROMPT_PATH = path.join(
  PROMPTS_DIR,
  'feedback.system.md',
);

/** @type {string | null} */
let cachedSystemPrompt = null;

/**
 * @typedef {{ id: string, label: string, covered: boolean }} FeedbackDomain
 * @typedef {{
 *   domains: FeedbackDomain[],
 *   toneSummary: string,
 *   overallComment: string,
 *   improvementTips: string[],
 *   reflectionQuestion: string,
 * }} FeedbackResult
 *
 * @typedef {{
 *   index?: number,
 *   role: 'student' | 'patient' | 'system' | string,
 *   text: string,
 *   createdAt?: string,
 *   toneSeverity?: string,
 *   source?: string,
 * }} Turn
 *
 * @typedef {{ id: string, label: string, description?: string }} EducationTarget
 */

/**
 * @param {string} [promptPath]
 */
export function loadFeedbackSystemPrompt(promptPath = DEFAULT_PROMPT_PATH) {
  if ((!promptPath || promptPath === DEFAULT_PROMPT_PATH) && cachedSystemPrompt) {
    return cachedSystemPrompt;
  }
  const text = readFileSync(promptPath || DEFAULT_PROMPT_PATH, 'utf8');
  if (!promptPath || promptPath === DEFAULT_PROMPT_PATH) {
    cachedSystemPrompt = text;
  }
  return text;
}

/**
 * Flatten turns into plain transcript text for the LLM.
 * @param {Turn[]} turns
 */
export function formatTranscriptText(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return '(empty transcript)';
  }
  return turns
    .map((t) => {
      const role = String(t.role ?? 'unknown').toUpperCase();
      const tone =
        t.role === 'patient' && t.toneSeverity
          ? ` (tone=${t.toneSeverity})`
          : '';
      const source =
        t.role === 'student' && t.source ? ` [${t.source}]` : '';
      return `[${role}]${source}${tone} ${String(t.text ?? '').trim()}`;
    })
    .join('\n');
}

/**
 * @param {string} transcriptText
 * @param {EducationTarget[]} educationTargets
 * @returns {FeedbackDomain[]}
 */
function heuristicDomains(transcriptText, educationTargets) {
  const lower = transcriptText.toLowerCase();
  /** @type {Record<string, string[]>} */
  const hints = {
    meal_sequencing: ['meal sequenc', 'vegetables first', 'protein first', 'eat veg'],
    carbohydrate_identification: [
      'carb',
      'carbohydrate',
      'dim sum',
      'white rice',
      'swap',
      'refined',
    ],
    post_meal_glucose_reduction: [
      'walk',
      'after lunch',
      'post-meal',
      'post meal',
      '10-minute',
      '10 minute',
    ],
    burnout_coping: ['burnout', 'coping', 'stress', 'overwhelm', 'career', 'manageable'],
  };

  return educationTargets.map((t) => {
    const keys = hints[t.id] ?? [t.label.toLowerCase()];
    const covered = keys.some((k) => lower.includes(k));
    return { id: t.id, label: t.label, covered };
  });
}

/**
 * Deterministic FeedbackResult for mock mode / invalid mock echo payloads.
 * @param {{
 *   educationTargets: EducationTarget[],
 *   reflectionQuestion: string,
 *   transcriptText: string,
 * }} opts
 * @returns {FeedbackResult}
 */
export function buildMockFeedbackResult({
  educationTargets,
  reflectionQuestion,
  transcriptText,
}) {
  const domains = heuristicDomains(transcriptText, educationTargets);
  const coveredCount = domains.filter((d) => d.covered).length;
  return {
    domains,
    toneSummary:
      'Overall tone tended toward supportive coaching, with occasional clinical phrasing. No severe judgmental moments were flagged in this mock analysis.',
    overallComment:
      coveredCount === domains.length
        ? 'You touched all four education domains. Keep linking advice to the patient’s work and stress context.'
        : `You covered ${coveredCount} of ${domains.length} education domains. Review the checklist for gaps and reconnect advice to Mr. Leung’s lunch and burnout concerns.`,
    improvementTips: [
      'Ask one open question per domain before giving advice.',
      'Name empathy first when the patient mentions career fear or burnout.',
      'Offer one concrete, time-bound action the patient can try after a business lunch.',
    ],
    reflectionQuestion,
  };
}

/**
 * @param {string} content
 */
function parseJsonObject(content) {
  let text = String(content ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Feedback JSON root must be an object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {unknown} raw
 */
function isGenericOpenRouterMockPayload(raw) {
  return (
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    /** @type {any} */ (raw).mock === true &&
    !Array.isArray(/** @type {any} */ (raw).domains)
  );
}

/**
 * Normalize LLM output against case education targets; reflection from case.
 * @param {Record<string, unknown>} raw
 * @param {EducationTarget[]} educationTargets
 * @param {string} reflectionQuestion
 * @returns {FeedbackResult}
 */
export function normalizeFeedbackResult(raw, educationTargets, reflectionQuestion) {
  if (!Array.isArray(educationTargets) || educationTargets.length !== 4) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Feedback requires exactly four education targets.',
      retryable: false,
      status: 400,
      details: { field: 'educationTargets' },
    });
  }

  const rawDomains = Array.isArray(raw.domains) ? raw.domains : [];
  /** @type {Map<string, boolean>} */
  const coveredById = new Map();
  for (const d of rawDomains) {
    if (!d || typeof d !== 'object') continue;
    const id = /** @type {any} */ (d).id;
    if (typeof id === 'string') {
      coveredById.set(id, Boolean(/** @type {any} */ (d).covered));
    }
  }

  const domains = educationTargets.map((t) => ({
    id: t.id,
    label: t.label,
    covered: coveredById.has(t.id) ? /** @type {boolean} */ (coveredById.get(t.id)) : false,
  }));

  const toneSummary =
    typeof raw.toneSummary === 'string' && raw.toneSummary.trim()
      ? raw.toneSummary.trim()
      : 'Tone summary was not available from the model; review the transcript for empathy versus judgmental phrasing.';

  const overallComment =
    typeof raw.overallComment === 'string' && raw.overallComment.trim()
      ? raw.overallComment.trim()
      : 'Overall comment was not available from the model.';

  let improvementTips = Array.isArray(raw.improvementTips)
    ? raw.improvementTips
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => /** @type {string} */ (t).trim())
    : [];
  if (improvementTips.length === 0) {
    improvementTips = [
      'Revisit missed education domains with one concrete tip each.',
      'Balance clinical accuracy with empathy when discussing lifestyle change.',
    ];
  }

  return {
    domains,
    toneSummary,
    overallComment,
    improvementTips,
    reflectionQuestion,
  };
}

/**
 * @param {{
 *   transcriptText: string,
 *   educationTargets: EducationTarget[],
 *   reflectionQuestion: string,
 * }} opts
 */
export function buildFeedbackUserMessage({
  transcriptText,
  educationTargets,
  reflectionQuestion,
}) {
  const targets = educationTargets.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description ?? '',
  }));
  return [
    '## Education targets (mark covered / not covered)',
    JSON.stringify(targets, null, 2),
    '',
    '## Case reflection question (do not rewrite; server will attach)',
    reflectionQuestion,
    '',
    '## Full transcript',
    transcriptText,
  ].join('\n');
}

/**
 * Resolve inputs from End-route shape or explicit test args.
 * @param {object} opts
 */
function resolveFeedbackInputs(opts) {
  const caseConfig = opts.caseConfig;
  const educationTargets =
    opts.educationTargets ?? caseConfig?.educationTargets;
  const reflectionQuestion =
    opts.reflectionQuestion ?? caseConfig?.feedback?.reflectionQuestion;
  const turnsOrTranscript = opts.turnsOrTranscript ?? opts.turns;

  return { educationTargets, reflectionQuestion, turnsOrTranscript };
}

/**
 * One-shot feedback analysis → FeedbackResult.
 *
 * @param {object} opts
 * @param {import('../models/caseModel.js').CaseConfig} [opts.caseConfig]
 * @param {Turn[]} [opts.turns]
 * @param {Turn[] | string} [opts.turnsOrTranscript]
 * @param {EducationTarget[]} [opts.educationTargets]
 * @param {string} [opts.reflectionQuestion]
 * @param {{ chatCompletion: Function, mode?: string }} opts.openRouter
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.promptPath]
 * @returns {Promise<FeedbackResult>}
 */
export async function generateFeedback(opts) {
  const { openRouter, systemPrompt, promptPath } = opts;
  const { educationTargets, reflectionQuestion, turnsOrTranscript } =
    resolveFeedbackInputs(opts);

  if (!openRouter || typeof openRouter.chatCompletion !== 'function') {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Feedback service requires an OpenRouter client.',
      retryable: false,
      status: 400,
      details: { field: 'openRouter' },
    });
  }

  if (typeof reflectionQuestion !== 'string' || !reflectionQuestion.trim()) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'reflectionQuestion is required.',
      retryable: false,
      status: 400,
      details: { field: 'reflectionQuestion' },
    });
  }

  if (!Array.isArray(educationTargets) || educationTargets.length !== 4) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Exactly four education targets are required.',
      retryable: false,
      status: 400,
      details: { field: 'educationTargets' },
    });
  }

  if (turnsOrTranscript == null) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'turns (or transcript text) are required.',
      retryable: false,
      status: 400,
      details: { field: 'turns' },
    });
  }

  const transcriptText =
    typeof turnsOrTranscript === 'string'
      ? turnsOrTranscript
      : formatTranscriptText(turnsOrTranscript);

  const system =
    systemPrompt ?? loadFeedbackSystemPrompt(promptPath ?? DEFAULT_PROMPT_PATH);
  const userContent = buildFeedbackUserMessage({
    transcriptText,
    educationTargets,
    reflectionQuestion: reflectionQuestion.trim(),
  });

  let completion;
  try {
    completion = await openRouter.chatCompletion({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION') throw err;
    throw new ApiError({
      code: 'FEEDBACK_LLM_FAILED',
      message: 'Feedback analysis failed. Please try ending the session again.',
      retryable: true,
      status: 502,
      details:
        err instanceof ApiError
          ? { cause: err.code, message: err.message }
          : String(err),
    });
  }

  const content = completion?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError({
      code: 'FEEDBACK_LLM_FAILED',
      message: 'Feedback analysis returned an empty response.',
      retryable: true,
      status: 502,
    });
  }

  let parsed;
  try {
    parsed = parseJsonObject(content);
  } catch (err) {
    throw new ApiError({
      code: 'FEEDBACK_LLM_FAILED',
      message: 'Feedback analysis returned invalid JSON.',
      retryable: true,
      status: 502,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  // Default OpenRouter mock returns an echo stub — synthesize structured feedback.
  if (
    isGenericOpenRouterMockPayload(parsed) ||
    (openRouter.mode === 'mock' && !Array.isArray(parsed.domains))
  ) {
    return buildMockFeedbackResult({
      educationTargets,
      reflectionQuestion: reflectionQuestion.trim(),
      transcriptText,
    });
  }

  try {
    return normalizeFeedbackResult(
      parsed,
      educationTargets,
      reflectionQuestion.trim(),
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError({
      code: 'FEEDBACK_LLM_FAILED',
      message: 'Feedback analysis could not be normalized.',
      retryable: true,
      status: 502,
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Convenience entry for POST /api/session/end after transcript write.
 * @param {object} opts
 * @param {Turn[]} opts.turns
 * @param {EducationTarget[]} [opts.educationTargets]
 * @param {string} [opts.reflectionQuestion]
 * @param {import('../models/caseModel.js').CaseConfig} [opts.caseConfig]
 * @param {{ chatCompletion: Function, mode?: string }} opts.openRouter
 * @returns {Promise<FeedbackResult>}
 */
export async function runFeedbackAfterEnd(opts) {
  return generateFeedback(opts);
}

export { DEFAULT_PROMPT_PATH };
