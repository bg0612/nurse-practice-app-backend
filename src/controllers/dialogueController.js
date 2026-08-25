import { generatePatientReply } from '../services/patientReplyService.js';
import { activeSessionRegistry } from '../services/activeSessionRegistry.js';
import { ApiError } from '../errors/apiError.js';

const STUDENT_SOURCES = new Set(['voice', 'typed']);
const TURN_ROLES = new Set(['student', 'patient']);
const MAX_ID_LENGTH = 128;
const MAX_UTTERANCE_LENGTH = 2000;
const MAX_CLIENT_TURNS = 60;

function validation(field, reason) {
  throw new ApiError({
    code: 'VALIDATION', message: 'Invalid patient-reply request.',
    retryable: false, status: 400, details: { field, reason },
  });
}

function requiredString(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || !value.trim()) validation(field, 'required non-empty string');
  const trimmed = value.trim();
  if (Array.from(trimmed).length > maxLength) validation(field, `must be at most ${maxLength} characters`);
  return trimmed;
}

export function validatePatientReplyRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) validation('body', 'must be an object');
  const req = body;
  const sessionId = requiredString(req.sessionId, 'sessionId');
  const caseId = requiredString(req.caseId, 'caseId');
  const clientTurnId = requiredString(req.clientTurnId, 'clientTurnId');
  const studentUtterance = requiredString(req.studentUtterance, 'studentUtterance', MAX_UTTERANCE_LENGTH);
  if (!STUDENT_SOURCES.has(req.studentSource)) validation('studentSource', 'must be voice|typed');
  if (!Array.isArray(req.turns) || req.turns.length > MAX_CLIENT_TURNS) validation('turns', `must be an array with at most ${MAX_CLIENT_TURNS} items`);
  const turns = req.turns.map((turn, index) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) validation(`turns[${index}]`, 'must be an object');
    if (!TURN_ROLES.has(turn.role)) validation(`turns[${index}].role`, 'must be student|patient');
    const text = requiredString(turn.text, `turns[${index}].text`, MAX_UTTERANCE_LENGTH);
    if (turn.role === 'student' && turn.source !== undefined && !STUDENT_SOURCES.has(turn.source)) {
      validation(`turns[${index}].source`, 'must be voice|typed');
    }
    if (turn.role === 'patient' && turn.source !== undefined) validation(`turns[${index}].source`, 'not allowed for patient turns');
    return {
      role: turn.role,
      text,
      ...(turn.role === 'student' && turn.source !== undefined ? { source: turn.source } : {}),
    };
  });
  return { sessionId, caseId, clientTurnId, turns, studentUtterance, studentSource: req.studentSource };
}

export async function patientReply(req, res, next, deps = {}) {
  try {
    const providers = req.app.locals?.providers;
    if (providers?.services?.llmEnabled === false) {
      throw new ApiError({ code: 'LLM_DISABLED', message: 'LLM service is disabled.', retryable: false, status: 503 });
    }
    const input = validatePatientReplyRequest(req.body);
    const registry = deps.activeSessionRegistry ?? req.app.locals?.activeSessionRegistry ?? activeSessionRegistry;
    const llmProvider = deps.llmProvider ?? providers?.llmProvider ?? providers?.foundry;
    const result = await registry.processPatientTurn(input, ({ caseConfig, committedHistory, revealedFactIds }) =>
      generatePatientReply({
        caseConfig,
        committedHistory,
        revealedFactIds,
        studentUtterance: input.studentUtterance,
        studentSource: input.studentSource,
        llmProvider,
        promptsDir: deps.promptsDir,
      }));
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
