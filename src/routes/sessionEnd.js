// backend/src/routes/sessionEnd.js
import { Router } from 'express';
import {
  runFeedbackAfterEnd,
  sessionEnd,
  getSessionFeedback,
} from '../controllers/sessionEndController.js';
import { generateFeedback } from '../services/feedbackService.js';

export { runFeedbackAfterEnd };

/**
 * M6: POST /api/session/end (schedule background feedback analysis) and
 * GET /api/session/:sessionId/feedback (poll feedback status) (§6.4).
 * Nothing is persisted to disk.
 * @param {{
 *   casesDir?: string,
 *   generateFeedbackFn?: typeof generateFeedback,
 * }} [deps]
 */
export function createSessionEndRoutes(deps = {}) {
  const router = Router();

  router.post('/api/session/end', (req, res, next) => sessionEnd(req, res, next, deps));
  router.get('/api/session/:sessionId/feedback', (req, res, next) =>
    getSessionFeedback(req, res, next, deps),
  );

  return router;
}

/**
 * Mount session/end on an Express app (composition helper for M6/M8).
 * @param {import('express').Express} app
 * @param {Parameters<typeof createSessionEndRoutes>[0]} [deps]
 */
export function wireSessionEnd(app, deps = {}) {
  app.use(createSessionEndRoutes(deps));
  return app;
}
