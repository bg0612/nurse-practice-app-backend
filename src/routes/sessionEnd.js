import { Router } from 'express';
import { runFeedbackAfterEnd, sessionEnd, validateSessionEndRequest } from '../controllers/sessionEndController.js';

export { runFeedbackAfterEnd, validateSessionEndRequest };

export function createSessionEndRoutes(deps = {}) {
  const router = Router();
  router.post('/api/session/end', (req, res, next) => sessionEnd(req, res, next, deps));
  return router;
}

export function wireSessionEnd(app, deps = {}) {
  app.use(createSessionEndRoutes(deps));
  return app;
}
