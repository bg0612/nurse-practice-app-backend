import { ApiError } from '../errors/apiError.js';
import { randomUUID } from 'node:crypto';

export const DEFAULT_ACTIVE_SESSION_TTL_MS = 30 * 60 * 1000;

function sessionError(code, message, status, details) {
  return new ApiError({ code, message, retryable: false, status, details });
}

function clone(value) {
  return structuredClone(value);
}

export class ActiveSessionRegistry {
  constructor({
    activeTtlMs = DEFAULT_ACTIVE_SESSION_TTL_MS,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    if (!Number.isSafeInteger(activeTtlMs) || activeTtlMs < 1) throw new TypeError('activeTtlMs must be a positive integer');
    if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('now, setTimer, and clearTimer must be functions');
    }
    this.sessions = new Map();
    this.activeTtlMs = activeTtlMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  scheduleExpiry(session, ttlMs) {
    if (session.expiryTimer !== undefined) this.clearTimer(session.expiryTimer);
    session.expiresAt = this.now() + ttlMs;
    const timer = this.setTimer(() => {
      if (this.sessions.get(session.sessionId) !== session) return;
      if (session.expiresAt <= this.now()) this.disposeSession(session);
      else this.scheduleExpiry(session, session.expiresAt - this.now());
    }, ttlMs);
    timer?.unref?.();
    session.expiryTimer = timer;
  }

  touchActiveSession(session) {
    this.scheduleExpiry(session, this.activeTtlMs);
  }

  disposeSession(session) {
    if (session.expiryTimer !== undefined) this.clearTimer(session.expiryTimer);
    session.transcript.length = 0;
    session.revealedFactIds.clear();
    session.turnsByClientId.clear();
    session.processingUniqueTurn = false;
    session.ending = false;
    session.endToken = undefined;
    session.caseConfig = undefined;
    session.endSnapshot = undefined;
    session.expiryTimer = undefined;
    this.sessions.delete(session.sessionId);
  }

  pruneExpired(at = this.now()) {
    let removed = 0;
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= at) {
        this.disposeSession(session);
        removed += 1;
      }
    }
    return removed;
  }

  createSession({ sessionId, caseId, caseConfig }) {
    if (this.sessions.has(sessionId)) {
      throw sessionError('SESSION_CONFLICT', 'Session could not be created.', 409);
    }
    const session = {
      sessionId,
      caseId,
      caseConfig,
      studentTurnCount: 0,
      transcript: [],
      revealedFactIds: new Set(),
      turnsByClientId: new Map(),
      processingUniqueTurn: false,
      ending: false,
      endToken: undefined,
      endSnapshot: undefined,
      expiresAt: 0,
      expiryTimer: undefined,
    };
    this.sessions.set(sessionId, session);
    this.scheduleExpiry(session, this.activeTtlMs);
    return this.getSessionSnapshot(sessionId, caseId);
  }

  bindSession(input) {
    return this.createSession(input);
  }

  assertSession(sessionId, caseId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', 404);
    if (session.expiresAt <= this.now()) {
      this.disposeSession(session);
      throw sessionError('SESSION_NOT_FOUND', 'Session not found.', 404);
    }
    if (session.caseId !== caseId) {
      throw sessionError('SESSION_CASE_MISMATCH', 'Session does not belong to this case.', 409);
    }
    this.touchActiveSession(session);
    return session;
  }

  getSessionSnapshot(sessionId, caseId) {
    const session = this.assertSession(sessionId, caseId);
    return this.snapshotSession(session);
  }

  snapshotSession(session) {
    return {
      sessionId: session.sessionId,
      caseId: session.caseId,
      studentTurnCount: session.studentTurnCount,
      turnLimitReached: session.studentTurnCount >= session.caseConfig.runtime.responseLimits.maxStudentTurns,
      transcript: clone(session.transcript),
      latestPatientReply: session.transcript.findLast((turn) => turn.role === 'patient')?.text ?? null,
    };
  }

  getCommittedTranscript(sessionId, caseId) {
    return this.getSessionSnapshot(sessionId, caseId).transcript;
  }

  getCaseConfig(sessionId, caseId) {
    return clone(this.assertSession(sessionId, caseId).caseConfig);
  }

  getLatestPatientReply(sessionId, caseId) {
    return this.getSessionSnapshot(sessionId, caseId).latestPatientReply;
  }

  async processPatientTurn({ sessionId, caseId, clientTurnId, studentUtterance, studentSource }, generate) {
    const session = this.assertSession(sessionId, caseId);
    const existing = session.turnsByClientId.get(clientTurnId);
    if (existing) {
      if (existing.studentUtterance !== studentUtterance || existing.studentSource !== studentSource) {
        throw sessionError('TURN_ID_CONFLICT', 'clientTurnId was already used for different input.', 409);
      }
      if (existing.result) return clone(existing.result);
      return existing.promise.then((result) => clone(result));
    }
    if (session.ending) {
      throw sessionError('SESSION_ENDING', 'Session End is already in progress.', 409);
    }
    if (session.studentTurnCount >= session.caseConfig.runtime.responseLimits.maxStudentTurns) {
      throw sessionError('TURN_LIMIT_REACHED', 'The maximum number of student turns has been reached.', 409);
    }
    if (session.processingUniqueTurn) {
      throw sessionError('SESSION_BUSY', 'Another student turn is being processed.', 409);
    }

    const acceptedTurnCount = session.studentTurnCount + 1;
    const committedHistory = clone(session.transcript);
    session.processingUniqueTurn = true;
    const entry = { studentUtterance, studentSource, promise: undefined };
    entry.promise = (async () => {
      try {
        const patientReply = await generate({
          caseConfig: session.caseConfig,
          committedHistory,
          revealedFactIds: [...session.revealedFactIds],
          acceptedTurnCount,
        });
        const normalizedPatientReply = {
          replyText: patientReply.replyText,
          revealedFactIds: Array.isArray(patientReply.revealedFactIds) ? [...patientReply.revealedFactIds] : [],
          recovered: Boolean(patientReply.recovered),
          ...(patientReply.recoveryCode ? { recoveryCode: patientReply.recoveryCode } : {}),
        };
        if (this.sessions.get(sessionId) !== session || session.expiresAt <= this.now()) {
          if (this.sessions.get(sessionId) === session) this.disposeSession(session);
          throw sessionError('SESSION_NOT_FOUND', 'Session not found.', 404);
        }
        const createdAt = new Date().toISOString();
        session.transcript.push({
          index: session.transcript.length,
          role: 'student',
          text: studentUtterance,
          createdAt,
          source: studentSource,
        });
        session.transcript.push({
          index: session.transcript.length,
          role: 'patient',
          text: normalizedPatientReply.replyText,
          createdAt: new Date().toISOString(),
          generation: {
            recovered: normalizedPatientReply.recovered,
            ...(normalizedPatientReply.recoveryCode ? { recoveryCode: normalizedPatientReply.recoveryCode } : {}),
          },
        });
        for (const factId of normalizedPatientReply.revealedFactIds) session.revealedFactIds.add(factId);
        const countedTurnCount = normalizedPatientReply.recovered ? session.studentTurnCount : acceptedTurnCount;
        session.studentTurnCount = countedTurnCount;
        const result = {
          patientReply: clone({
            replyText: normalizedPatientReply.replyText,
            recovered: normalizedPatientReply.recovered,
            ...(normalizedPatientReply.recoveryCode ? { recoveryCode: normalizedPatientReply.recoveryCode } : {}),
          }),
          studentTurnCount: countedTurnCount,
          turnLimitReached: countedTurnCount >= session.caseConfig.runtime.responseLimits.maxStudentTurns,
        };
        entry.result = result;
        this.touchActiveSession(session);
        return clone(result);
      } catch (error) {
        session.turnsByClientId.delete(clientTurnId);
        throw error;
      } finally {
        session.processingUniqueTurn = false;
      }
    })();
    session.turnsByClientId.set(clientTurnId, entry);
    return entry.promise;
  }

  /**
   * Atomically freeze the dialogue transcript for End processing.
   * Concurrent callers receive the same token and immutable snapshot.
   */
  beginEnd(sessionId, caseId) {
    const session = this.assertSession(sessionId, caseId);
    if (session.ending) {
      return {
        state: 'ending',
        endToken: session.endToken,
        snapshot: clone(session.endSnapshot),
      };
    }
    if (session.processingUniqueTurn) {
      throw sessionError('SESSION_BUSY', 'A student turn is still being processed.', 409);
    }
    session.ending = true;
    session.endToken = randomUUID();
    session.endSnapshot = this.snapshotSession(session);
    return {
      state: 'ending',
      endToken: session.endToken,
      snapshot: clone(session.endSnapshot),
    };
  }

  cancelEnd(sessionId, caseId, endToken) {
    const session = this.assertSession(sessionId, caseId);
    if (!session.ending || session.endToken !== endToken) {
      throw sessionError('SESSION_END_STATE', 'Session End state has changed.', 409);
    }
    session.ending = false;
    session.endToken = undefined;
    session.endSnapshot = undefined;
    return this.snapshotSession(session);
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) this.disposeSession(session);
  }
}

export const activeSessionRegistry = new ActiveSessionRegistry();
