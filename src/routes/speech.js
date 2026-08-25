import { Router } from 'express';
import { synthesizeSpeech } from '../controllers/speechController.js';

/** Injectable TTS route composition reserved for WP-07 registration. */
export function createSpeechRoutes(deps = {}) {
  const router = Router();
  router.post('/api/speech/synthesize', (req, res, next) =>
    synthesizeSpeech(req, res, next, deps),
  );
  return router;
}

