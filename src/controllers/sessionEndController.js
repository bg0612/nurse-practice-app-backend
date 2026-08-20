// backend/src/controllers/sessionEndController.js
import { loadCaseById } from '../models/caseModel.js';
import { ApiError } from '../errors/apiError.js';
import {
  generateFeedback,
  runFeedbackAfterEnd,
} from '../services/feedbackService.js';
import {
  isFeedbackGenerating,
  markFeedbackGenerating,
  markFeedbackDone,
  saveFeedbackResult,
  loadFeedbackResult,
} from '../models/feedbackModel.js';

export { runFeedbackAfterEnd };

const VALID_ROLES = new Set(['student', 'patient', 'system']);
const VALID_SOURCES = new Set(['voice', 'typed']);
const VALID_TONES = new Set(['good', 'bad']);

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError({
      code: 'VALIDATION',
      message: `Invalid request: ${field} is required.`,
      retryable: false,
      status: 400,
      details: { field },
    });
  }
  return value.trim();
}

/**
 * @param {unknown} turns
 */
function validateTurns(turns) {
  if (!Array.isArray(turns)) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid request: turns must be an array.',
      retryable: false,
      status: 400,
      details: { field: 'turns' },
    });
  }

  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: `Invalid request: turns[${i}] must be an object.`,
        retryable: false,
        status: 400,
        details: { field: `turns[${i}]` },
      });
    }
    if (!VALID_ROLES.has(t.role)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: `Invalid request: turns[${i}].role is invalid.`,
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].role` },
      });
    }
    if (typeof t.text !== 'string') {
      throw new ApiError({
        code: 'VALIDATION',
        message: `Invalid request: turns[${i}].text must be a string.`,
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].text` },
      });
    }
    if (t.source !== undefined && !VALID_SOURCES.has(t.source)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: `Invalid request: turns[${i}].source is invalid.`,
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].source` },
      });
    }
    if (t.tone !== undefined && !VALID_TONES.has(t.tone)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: `Invalid request: turns[${i}].tone is invalid.`,
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].tone` },
      });
    }
  }

  return /** @type {Array<{ index?: number, role: string, text: string, createdAt?: string, source?: string, tone?: "good" | "bad", stageId?: string, answerId?: string }>} */ (
    turns
  );
}

/**
 * Run feedback analysis in the background, keeping the result in memory so it
 * can be polled via GET /api/session/:sessionId/feedback. Never throws upward.
 */
async function runBackgroundFeedback({
  sessionId,
  caseConfig,
  turns,
  openRouter,
  llmEnabled,
  feedbackFn,
}) {
  try {
    if (!llmEnabled || !openRouter) {
      await saveFeedbackResult(sessionId, {
        ok: false,
        message: 'Feedback service is disabled.',
      });
      return;
    }
    const feedback = await feedbackFn({ caseConfig, turns, openRouter });
    await saveFeedbackResult(sessionId, { ok: true, feedback });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveFeedbackResult(sessionId, { ok: false, message }).catch(
      () => {},
    );
  } finally {
    markFeedbackDone(sessionId);
  }
}

/**
 * POST /api/session/end — schedule background feedback analysis (§6.4).
 * Returns immediately; the frontend polls GET /api/session/:sessionId/feedback.
 * No transcript or feedback is persisted to disk.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{
 *   casesDir?: string,
 *   generateFeedbackFn?: typeof generateFeedback,
 * }} deps
 */
export async function sessionEnd(req, res, next, deps = {}) {
  const casesDir = deps.casesDir;
  const feedbackFn = deps.generateFeedbackFn ?? generateFeedback;

  try {
    const body = req.body ?? {};
    const sessionId = requireNonEmptyString(body.sessionId, 'sessionId');
    const caseId = requireNonEmptyString(body.caseId, 'caseId');
    const startedAt = requireNonEmptyString(body.startedAt, 'startedAt');
    const endedAt = requireNonEmptyString(body.endedAt, 'endedAt');
    const turns = validateTurns(body.turns);

    const caseConfig = loadCaseById(caseId, { casesDir });

    // Schedule M6 feedback analysis in the background
    if (!isFeedbackGenerating(sessionId)) {
      markFeedbackGenerating(sessionId);
      const providers = req.app?.locals?.providers;
      runBackgroundFeedback({
        sessionId,
        caseConfig,
        turns,
        openRouter: providers?.openRouter,
        llmEnabled: providers?.services?.llmEnabled !== false,
        feedbackFn,
      }).catch((err) => {
        console.error(
          `[session-end] background feedback failed for ${sessionId}:`,
          err,
        );
        markFeedbackDone(sessionId);
      });
    }

    // Return immediately
    res.status(200).json({ sessionId, feedbackStatus: 'generating' });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/session/:sessionId/feedback — poll feedback status.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function getSessionFeedback(req, res, next) {
  try {
    const sessionId = req.params?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new ApiError({
        code: 'VALIDATION',
        message: 'Invalid request: sessionId is required.',
        retryable: false,
        status: 400,
        details: { field: 'sessionId' },
      });
    }

    const result = await loadFeedbackResult(sessionId.trim());
    if (result) {
      if (result.ok) {
        res.status(200).json({ status: 'ready', feedback: result.feedback });
        return;
      }
      res.status(200).json({ status: 'error', message: result.message });
      return;
    }

    if (isFeedbackGenerating(sessionId.trim())) {
      res.status(200).json({ status: 'generating' });
      return;
    }

    res.status(404).json({
      code: 'FEEDBACK_NOT_FOUND',
      message: 'No feedback for this session.',
      retryable: false,
      status: 404,
    });
  } catch (err) {
    next(err);
  }
}
