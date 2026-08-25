import { ApiError } from '../errors/apiError.js';
import {
  buildUnavailableFeedback,
  generateFeedback,
  runFeedbackAfterEnd,
} from '../services/feedbackService.js';
import { activeSessionRegistry } from '../services/activeSessionRegistry.js';
import { runEndOperationOnce } from '../models/feedbackModel.js';

export { runFeedbackAfterEnd };

const MAX_ID_LENGTH = 128;
const MAX_CLIENT_TURNS = 60;
const MAX_TURN_TEXT_LENGTH = 2000;
const TURN_ROLES = new Set(['student', 'patient']);
const STUDENT_SOURCES = new Set(['voice', 'typed']);

function validation(field, reason) {
  throw new ApiError({
    code: 'VALIDATION',
    message: 'Invalid session End request.',
    retryable: false,
    status: 400,
    details: { field, reason },
  });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) validation(field, 'must be a non-empty string');
  const text = value.trim();
  if (Array.from(text).length > MAX_ID_LENGTH) validation(field, `must be at most ${MAX_ID_LENGTH} characters`);
  return text;
}

function isoTimestamp(value, field) {
  if (typeof value !== 'string' || !value.trim()) validation(field, 'must be an ISO-8601 timestamp');
  const text = value.trim();
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    validation(field, 'must be a UTC ISO-8601 timestamp');
  }
  return { text, milliseconds };
}

function validateClientTurns(turns) {
  if (!Array.isArray(turns) || turns.length > MAX_CLIENT_TURNS) {
    validation('turns', `must be an array with at most ${MAX_CLIENT_TURNS} items`);
  }
  turns.forEach((turn, index) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) validation(`turns[${index}]`, 'must be an object');
    if (!TURN_ROLES.has(turn.role)) validation(`turns[${index}].role`, 'must be student or patient');
    if (typeof turn.text !== 'string' || !turn.text.trim() || Array.from(turn.text).length > MAX_TURN_TEXT_LENGTH) {
      validation(`turns[${index}].text`, `must be a non-empty string of at most ${MAX_TURN_TEXT_LENGTH} characters`);
    }
    if (turn.createdAt !== undefined) isoTimestamp(turn.createdAt, `turns[${index}].createdAt`);
    if (turn.role === 'student' && turn.source !== undefined && !STUDENT_SOURCES.has(turn.source)) {
      validation(`turns[${index}].source`, 'must be voice or typed');
    }
  });
  // Contents are deliberately not consumed. The registry transcript is the
  // sole authority, so a valid-but-tampered client transcript cannot affect feedback.
  return turns;
}

export function validateSessionEndRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) validation('body', 'must be an object');
  const sessionId = requiredString(body.sessionId, 'sessionId');
  const caseId = requiredString(body.caseId, 'caseId');
  const started = isoTimestamp(body.startedAt, 'startedAt');
  const ended = isoTimestamp(body.endedAt, 'endedAt');
  if (ended.milliseconds < started.milliseconds) validation('endedAt', 'must not be before startedAt');
  validateClientTurns(body.turns);
  return { sessionId, caseId, startedAt: started.text, endedAt: ended.text };
}

/** POST /api/session/end — synchronous End; the authoritative session is scrubbed after completion. */
export async function sessionEnd(req, res, next, deps = {}) {
  try {
    const input = validateSessionEndRequest(req.body);
    const registry = deps.activeSessionRegistry ?? req.app.locals?.activeSessionRegistry ?? activeSessionRegistry;
    const providers = req.app.locals?.providers;
    const llmProvider = deps.llmProvider ?? providers?.llmProvider ?? providers?.foundry;
    const feedbackFn = deps.generateFeedbackFn ?? generateFeedback;

    const result = await runEndOperationOnce(registry, input.sessionId, async () => {
      const end = registry.beginEnd(input.sessionId, input.caseId);
      const caseConfig = registry.getCaseConfig(input.sessionId, input.caseId);
      try {
        if (providers?.services?.llmEnabled === false) {
          return { feedback: buildUnavailableFeedback(caseConfig) };
        }
        try {
          const feedback = await feedbackFn({
            caseConfig,
            turns: end.snapshot.transcript,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            llmProvider,
          });
          return { feedback };
        } catch {
          return { feedback: buildUnavailableFeedback(caseConfig) };
        }
      } finally {
        registry.deleteSession(input.sessionId);
      }
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
