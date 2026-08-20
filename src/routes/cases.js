// backend/src/routes/cases.js
import { Router } from 'express';
import { getCase, startSessionHandler } from '../controllers/casesController.js';

/**
 * M4 HTTP routes: GET /api/cases/:caseId, POST /api/session/start
 * @param {{ casesDir?: string }} [deps]
 */
export function createCaseRoutes(deps = {}) {
  const router = Router();
  const casesDir = deps.casesDir;

  router.get('/api/cases/:caseId', (req, res, next) =>
    getCase(req, res, next, { casesDir }),
  );

  router.post('/api/session/start', (req, res, next) =>
    startSessionHandler(req, res, next, { casesDir }),
  );

  return router;
}
