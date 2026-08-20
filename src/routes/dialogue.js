// backend/src/routes/dialogue.js
import { Router } from 'express';
import { patientReply, validatePatientReplyRequest } from '../controllers/dialogueController.js';

export { validatePatientReplyRequest };

/**
 * M5 HTTP: POST /api/dialogue/patient-reply only.
 * @param {{ casesDir?: string, promptsDir?: string }} [deps]
 */
export function createDialogueRoutes(deps = {}) {
  const router = Router();

  router.post('/api/dialogue/patient-reply', (req, res, next) =>
    patientReply(req, res, next, deps),
  );

  return router;
}
