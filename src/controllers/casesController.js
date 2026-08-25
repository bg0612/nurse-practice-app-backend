// backend/src/controllers/casesController.js
import { loadCaseById, startSession, toCasePublicView } from '../models/caseModel.js';
import { ApiError } from '../errors/apiError.js';
import { activeSessionRegistry } from '../services/activeSessionRegistry.js';

/**
 * GET /api/cases/:caseId
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{ casesDir?: string }} deps
 */
export function getCase(req, res, next, deps = {}) {
  try {
    const caseConfig = loadCaseById(req.params.caseId, { casesDir: deps.casesDir });
    res.status(200).json(toCasePublicView(caseConfig));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/session/start
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{ casesDir?: string }} deps
 */
export function startSessionHandler(req, res, next, deps = {}) {
  try {
    const caseId = req.body?.caseId;
    if (typeof caseId !== 'string' || caseId.trim() === '') {
      throw new ApiError({
        code: 'CASE_NOT_FOUND',
        message: 'Case not found.',
        retryable: false,
        status: 404,
        details: { reason: 'caseId is required' },
      });
    }
    const normalizedCaseId = caseId.trim();
    const result = startSession(normalizedCaseId, { casesDir: deps.casesDir });
    const { caseConfig, ...publicResult } = result;
    const registry = deps.activeSessionRegistry ?? req.app.locals?.activeSessionRegistry ?? activeSessionRegistry;
    registry.createSession({
      sessionId: result.sessionId,
      caseId: normalizedCaseId,
      caseConfig,
    });
    res.status(200).json(publicResult);
  } catch (err) {
    next(err);
  }
}
