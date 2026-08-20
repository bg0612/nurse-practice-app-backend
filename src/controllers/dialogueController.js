// backend/src/controllers/dialogueController.js
import { generatePatientReply } from '../services/patientReplyService.js';
import { ApiError } from '../errors/apiError.js';

const STUDENT_SOURCES = new Set(['voice', 'typed']);
const TURN_ROLES = new Set(['student', 'patient', 'system']);

/**
 * Validate POST /api/dialogue/patient-reply body (§6.3).
 * @param {unknown} body
 */
export function validatePatientReplyRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid patient-reply request.',
      retryable: false,
      status: 400,
      details: { reason: 'body must be an object' },
    });
  }

  const req = /** @type {Record<string, unknown>} */ (body);

  for (const field of ['sessionId', 'caseId', 'studentUtterance']) {
    if (typeof req[field] !== 'string' || req[field].trim() === '') {
      throw new ApiError({
        code: 'VALIDATION',
        message: 'Invalid patient-reply request.',
        retryable: false,
        status: 400,
        details: { field, reason: 'required non-empty string' },
      });
    }
  }

  if (typeof req.studentSource !== 'string' || !STUDENT_SOURCES.has(req.studentSource)) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid patient-reply request.',
      retryable: false,
      status: 400,
      details: { field: 'studentSource', reason: 'must be voice|typed' },
    });
  }

  if (!Array.isArray(req.turns)) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid patient-reply request.',
      retryable: false,
      status: 400,
      details: { field: 'turns', reason: 'must be an array' },
    });
  }

  for (let i = 0; i < req.turns.length; i += 1) {
    const turn = req.turns[i];
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: 'Invalid patient-reply request.',
        retryable: false,
        status: 400,
        details: { field: `turns[${i}]`, reason: 'must be an object' },
      });
    }
    const t = /** @type {Record<string, unknown>} */ (turn);
    if (typeof t.role !== 'string' || !TURN_ROLES.has(t.role)) {
      throw new ApiError({
        code: 'VALIDATION',
        message: 'Invalid patient-reply request.',
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].role`, reason: 'must be student|patient|system' },
      });
    }
    if (typeof t.text !== 'string') {
      throw new ApiError({
        code: 'VALIDATION',
        message: 'Invalid patient-reply request.',
        retryable: false,
        status: 400,
        details: { field: `turns[${i}].text`, reason: 'must be a string' },
      });
    }
  }

  if (
    typeof req.highestUnlockedOrder !== 'number' ||
    !Number.isInteger(req.highestUnlockedOrder) ||
    req.highestUnlockedOrder < 1
  ) {
    throw new ApiError({
      code: 'VALIDATION',
      message: 'Invalid patient-reply request.',
      retryable: false,
      status: 400,
      details: { field: 'highestUnlockedOrder', reason: 'must be a positive integer' },
    });
  }

  return {
    sessionId: /** @type {string} */ (req.sessionId).trim(),
    caseId: /** @type {string} */ (req.caseId).trim(),
    turns: /** @type {import('../services/patientReplyService.js').Turn[]} */ (req.turns),
    studentUtterance: /** @type {string} */ (req.studentUtterance).trim(),
    studentSource: /** @type {'voice' | 'typed'} */ (req.studentSource),
    highestUnlockedOrder: /** @type {number} */ (req.highestUnlockedOrder),
  };
}

/**
 * POST /api/dialogue/patient-reply
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{ casesDir?: string, promptsDir?: string }} deps
 */
export async function patientReply(req, res, next, deps = {}) {
  try {
    const providers = req.app.locals?.providers;
    if (providers?.services && providers.services.llmEnabled === false) {
      throw new ApiError({
        code: 'LLM_DISABLED',
        message: 'LLM service is disabled. Set LLM_ENABLED=true in the server .env.',
        retryable: false,
        status: 503,
      });
    }
    const input = validatePatientReplyRequest(req.body);
    const openRouter = providers?.openRouter;
    const result = await generatePatientReply({
      ...input,
      openRouter,
      casesDir: deps.casesDir,
      promptsDir: deps.promptsDir,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
