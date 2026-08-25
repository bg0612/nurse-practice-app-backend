import { ApiError } from '../errors/apiError.js';
import { loadCaseById } from '../models/caseModel.js';
import { assertTtsProvider } from './ttsProvider.js';

const MAX_IDENTIFIER_CHARACTERS = 128;
const ABSOLUTE_MAX_TEXT_CHARACTERS = 10_000;

function validation(field, reason) {
  throw new ApiError({
    code: 'VALIDATION',
    message: 'Invalid speech synthesis request.',
    retryable: false,
    status: 400,
    details: { field, reason },
  });
}

export function validateSpeechSynthesisRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    validation('body', 'must be an object');
  }
  const request = /** @type {Record<string, unknown>} */ (body);
  for (const field of ['sessionId', 'caseId', 'text']) {
    if (typeof request[field] !== 'string' || request[field].trim() === '') {
      validation(field, 'must be a non-empty string');
    }
  }
  for (const field of ['sessionId', 'caseId']) {
    if (/** @type {string} */ (request[field]).length > MAX_IDENTIFIER_CHARACTERS) {
      validation(field, `must not exceed ${MAX_IDENTIFIER_CHARACTERS} characters`);
    }
  }
  if (/** @type {string} */ (request.text).length > ABSOLUTE_MAX_TEXT_CHARACTERS) {
    validation('text', 'request is too large');
  }
  return {
    sessionId: /** @type {string} */ (request.sessionId),
    caseId: /** @type {string} */ (request.caseId),
    text: /** @type {string} */ (request.text),
  };
}

function normalizeLatestReply(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.replyText === 'string') return value.replyText;
    if (typeof value.patientReply?.replyText === 'string') return value.patientReply.replyText;
  }
  return null;
}

async function readLatestReply({ sessionId, caseId, getLatestPatientReply, sessionRegistry }) {
  const getter =
    getLatestPatientReply ??
    (typeof sessionRegistry?.getLatestPatientReply === 'function'
      ? sessionRegistry.getLatestPatientReply.bind(sessionRegistry)
      : null);
  if (!getter) {
    throw new ApiError({
      code: 'TTS_FAILED',
      message: 'Patient speech is temporarily unavailable.',
      retryable: true,
      status: 503,
    });
  }
  let result;
  try {
    result = await getter(sessionId, caseId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      code: 'TTS_FAILED',
      message: 'Patient speech is temporarily unavailable.',
      retryable: true,
      status: 503,
    });
  }
  const latest = normalizeLatestReply(result);
  if (latest === null) {
    throw new ApiError({
      code: 'SESSION_NOT_FOUND',
      message: 'Session not found.',
      retryable: false,
      status: 404,
    });
  }
  return latest;
}

/** Synthesize only the authoritative latest patient reply for a bound session. */
export async function synthesizePatientSpeech({
  sessionId,
  caseId,
  text,
  ttsProvider,
  getLatestPatientReply,
  sessionRegistry,
  casesDir,
}) {
  const caseConfig = loadCaseById(caseId, { casesDir });
  const latestReply = await readLatestReply({
    sessionId,
    caseId,
    getLatestPatientReply,
    sessionRegistry,
  });
  if (text !== latestReply) {
    validation('text', 'must match the latest committed patient reply');
  }

  assertTtsProvider(ttsProvider);
  try {
    const result = await ttsProvider.synthesize({
      text,
      voiceId: caseConfig.runtime.voice.voiceId,
      language: caseConfig.meta.language,
      outputFormat: caseConfig.runtime.voice.outputFormat,
      ...(caseConfig.runtime.voice.rate === undefined ? {} : { rate: caseConfig.runtime.voice.rate }),
      ...(caseConfig.runtime.voice.pitch === undefined ? {} : { pitch: caseConfig.runtime.voice.pitch }),
    });
    if (
      !result ||
      typeof result.mediaType !== 'string' ||
      !/^(?:audio\/[a-z0-9.+-]+|application\/octet-stream)$/i.test(result.mediaType) ||
      !(result.audio instanceof Uint8Array) ||
      result.audio.byteLength === 0
    ) {
      throw new Error('invalid TTS provider result');
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'TTS_FAILED') throw error;
    throw new ApiError({
      code: 'TTS_FAILED',
      message: 'Patient speech is temporarily unavailable.',
      retryable: true,
      status: 502,
    });
  }
}
