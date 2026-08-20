// backend/src/models/feedbackModel.js
// In-memory feedback result + in-flight tracking for background feedback
// generation. Results are never written to disk; they live for the lifetime of
// the server process and are polled via GET /api/session/:sessionId/feedback.

// Completed feedback results, keyed by sessionId.
const results = new Map();

// In-memory set of sessionIds currently being generated. Lives at module level so
// POST /api/session/end and GET /api/session/:id/feedback share the same view.
const inFlight = new Set();

export function isFeedbackGenerating(sessionId) {
  return inFlight.has(sessionId);
}

export function markFeedbackGenerating(sessionId) {
  inFlight.add(sessionId);
}

export function markFeedbackDone(sessionId) {
  inFlight.delete(sessionId);
}

/**
 * Store a feedback result in memory: { ok: true, feedback } or { ok: false, message }.
 * @param {string} sessionId
 * @param {{ ok: boolean, feedback?: unknown, message?: string }} result
 */
export async function saveFeedbackResult(sessionId, result) {
  results.set(sessionId, result);
}

/**
 * Load an in-memory feedback result, or null when absent.
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, feedback?: unknown, message?: string } | null>}
 */
export async function loadFeedbackResult(sessionId) {
  return results.get(sessionId) ?? null;
}