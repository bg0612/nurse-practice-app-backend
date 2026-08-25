import {
  synthesizePatientSpeech,
  validateSpeechSynthesisRequest,
} from '../services/speechSynthesisService.js';

/** POST /api/speech/synthesize */
export async function synthesizeSpeech(req, res, next, deps = {}) {
  try {
    const input = validateSpeechSynthesisRequest(req.body);
    const ttsProvider = deps.ttsProvider ?? req.app.locals?.providers?.tts;
    const result = await synthesizePatientSpeech({
      ...input,
      ttsProvider,
      getLatestPatientReply: deps.getLatestPatientReply,
      sessionRegistry:
        deps.sessionRegistry ??
        deps.activeSessionRegistry ??
        req.app.locals?.activeSessionRegistry,
      casesDir: deps.casesDir,
    });
    res.status(200);
    res.set('Content-Type', result.mediaType);
    res.set('Content-Length', String(result.audio.byteLength));
    res.send(Buffer.from(result.audio));
  } catch (error) {
    next(error);
  }
}
