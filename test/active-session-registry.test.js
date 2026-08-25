import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActiveSessionRegistry } from '../src/services/activeSessionRegistry.js';
import { loadCaseById } from '../src/models/caseModel.js';

const caseConfig = loadCaseById('case-1-david-leung');
const reply = { replyText: 'I can answer that briefly.', revealedFactIds: [], recovered: false };

function setup() {
  const registry = new ActiveSessionRegistry();
  registry.createSession({ sessionId: 'session-1', caseId: caseConfig.meta.caseId, caseConfig });
  return registry;
}

function expiringSetup({ activeTtlMs = 100 } = {}) {
  let currentTime = 1_000;
  let nextTimerId = 0;
  const clearedTimers = [];
  const registry = new ActiveSessionRegistry({
    activeTtlMs,
    now: () => currentTime,
    setTimer: () => ({ id: ++nextTimerId, unref() {} }),
    clearTimer: (timer) => clearedTimers.push(timer.id),
  });
  registry.createSession({ sessionId: 'session-1', caseId: caseConfig.meta.caseId, caseConfig });
  return {
    registry,
    clearedTimers,
    advance(ms) { currentTime += ms; },
  };
}

function input(clientTurnId, overrides = {}) {
  return {
    sessionId: 'session-1', caseId: caseConfig.meta.caseId, clientTurnId,
    studentUtterance: `Question ${clientTurnId}?`, studentSource: 'typed', ...overrides,
  };
}

describe('ActiveSessionRegistry', () => {
  it('coalesces a concurrent duplicate and caches its result', async () => {
    const registry = setup();
    let resolve;
    let calls = 0;
    const generated = new Promise((done) => { resolve = done; });
    const first = registry.processPatientTurn(input('turn-1'), async () => { calls += 1; return generated; });
    const duplicate = registry.processPatientTurn(input('turn-1'), async () => { calls += 1; return reply; });
    resolve(reply);
    const [a, b] = await Promise.all([first, duplicate]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.equal((await registry.processPatientTurn(input('turn-1'), async () => reply)).studentTurnCount, 1);
    assert.equal(registry.getCommittedTranscript('session-1', caseConfig.meta.caseId).length, 2);
  });

  it('rolls back a transport failure so the stable id can retry once without double count', async () => {
    const registry = setup();
    await assert.rejects(registry.processPatientTurn(input('turn-1'), async () => { throw new Error('transport'); }));
    assert.equal(registry.getSessionSnapshot('session-1', caseConfig.meta.caseId).studentTurnCount, 0);
    const result = await registry.processPatientTurn(input('turn-1'), async ({ committedHistory }) => {
      assert.deepEqual(committedHistory, []);
      return reply;
    });
    assert.equal(result.studentTurnCount, 1);
  });

  it('uses only committed server transcript and detects conflicting duplicate payloads', async () => {
    const registry = setup();
    await registry.processPatientTurn(input('turn-1'), async ({ committedHistory }) => {
      assert.deepEqual(committedHistory, []);
      return reply;
    });
    await assert.rejects(
      registry.processPatientTurn(input('turn-1', { studentUtterance: 'Tampered text' }), async () => reply),
      (err) => err.code === 'TURN_ID_CONFLICT',
    );
  });

  it('reports turn 25 and commits turn 30 with a lock', async () => {
    const registry = setup();
    let at25;
    let at30;
    for (let i = 1; i <= 30; i += 1) {
      const result = await registry.processPatientTurn(input(`turn-${i}`), async () => reply);
      if (i === 25) at25 = result;
      if (i === 30) at30 = result;
    }
    assert.equal(at25.studentTurnCount, 25);
    assert.equal(at25.turnLimitReached, false);
    assert.equal(at30.studentTurnCount, 30);
    assert.equal(at30.turnLimitReached, true);
    await assert.rejects(
      registry.processPatientTurn(input('turn-31'), async () => reply),
      (err) => err.code === 'TURN_LIMIT_REACHED' && err.status === 409,
    );
  });

  it('keeps a recovered technical exchange in the transcript without consuming a student turn', async () => {
    const registry = setup();
    const result = await registry.processPatientTurn(input('turn-recovered'), async () => ({
      replyText: 'Sorry, there was a technical error. Please try again.',
      revealedFactIds: [],
      recovered: true,
      recoveryCode: 'MODEL_OUTPUT_INVALID',
    }));
    assert.equal(result.studentTurnCount, 0);
    assert.equal(result.turnLimitReached, false);
    const transcript = registry.getCommittedTranscript('session-1', caseConfig.meta.caseId);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[1].generation.recovered, true);
    assert.equal(transcript[1].generation.recoveryCode, 'MODEL_OUTPUT_INVALID');
  });

  it('rejects session/case mismatch and exposes safe lifecycle reads', () => {
    const registry = setup();
    assert.throws(() => registry.getSessionSnapshot('session-1', 'other-case'), (err) => err.code === 'SESSION_CASE_MISMATCH');
    assert.equal(registry.getLatestPatientReply('session-1', caseConfig.meta.caseId), null);
    assert.equal(registry.getCaseConfig('session-1', caseConfig.meta.caseId).meta.caseId, caseConfig.meta.caseId);
    registry.deleteSession('session-1');
    assert.throws(
      () => registry.getSessionSnapshot('session-1', caseConfig.meta.caseId),
      (err) => err.code === 'SESSION_NOT_FOUND' && err.status === 404,
    );
  });

  it('refuses beginEnd while a patient turn is processing', async () => {
    const registry = setup();
    let resolve;
    const generated = new Promise((done) => { resolve = done; });
    const processing = registry.processPatientTurn(input('turn-1'), async () => generated);
    assert.throws(
      () => registry.beginEnd('session-1', caseConfig.meta.caseId),
      (err) => err.code === 'SESSION_BUSY' && err.status === 409,
    );
    resolve(reply);
    await processing;
  });

  it('atomically freezes End, coalesces beginEnd, and permits only cached duplicate turns', async () => {
    const registry = setup();
    const committed = await registry.processPatientTurn(input('turn-1'), async () => reply);
    const firstEnd = registry.beginEnd('session-1', caseConfig.meta.caseId);
    const concurrentEnd = registry.beginEnd('session-1', caseConfig.meta.caseId);
    assert.equal(firstEnd.state, 'ending');
    assert.equal(concurrentEnd.endToken, firstEnd.endToken);
    assert.deepEqual(concurrentEnd.snapshot, firstEnd.snapshot);
    assert.equal(firstEnd.snapshot.studentTurnCount, 1);

    const duplicate = await registry.processPatientTurn(input('turn-1'), async () => {
      throw new Error('cached duplicate must not regenerate');
    });
    assert.deepEqual(duplicate, committed);
    await assert.rejects(
      registry.processPatientTurn(input('turn-2'), async () => reply),
      (err) => err.code === 'SESSION_ENDING' && err.status === 409,
    );
    assert.deepEqual(firstEnd.snapshot.transcript, registry.getCommittedTranscript('session-1', caseConfig.meta.caseId));
  });

  it('cancelEnd reopens the session and invalidates the old token', async () => {
    const registry = setup();
    const end = registry.beginEnd('session-1', caseConfig.meta.caseId);
    const reopened = registry.cancelEnd('session-1', caseConfig.meta.caseId, end.endToken);
    assert.equal(reopened.studentTurnCount, 0);
    const result = await registry.processPatientTurn(input('turn-1'), async () => reply);
    assert.equal(result.studentTurnCount, 1);
    assert.throws(
      () => registry.cancelEnd('session-1', caseConfig.meta.caseId, end.endToken),
      (err) => err.code === 'SESSION_END_STATE',
    );
  });

  it('deletes the frozen session once End has completed', async () => {
    const registry = setup();
    const end = registry.beginEnd('session-1', caseConfig.meta.caseId);
    assert.equal(end.state, 'ending');
    assert.equal(registry.sessions.has('session-1'), true);
    registry.deleteSession('session-1');
    assert.equal(registry.sessions.has('session-1'), false);
    await assert.rejects(
      registry.processPatientTurn(input('turn-1'), async () => reply),
      (err) => err.code === 'SESSION_NOT_FOUND' && err.status === 404,
    );
  });

  it('keeps revealed fact IDs in session memory without exposing them in the transcript or snapshot', async () => {
    const registry = setup();
    let firstContext;
    await registry.processPatientTurn(input('turn-1'), async ({ revealedFactIds }) => {
      firstContext = revealedFactIds;
      return { replyText: 'I was recently diagnosed.', revealedFactIds: ['healthy_coping.facts.0'], recovered: false };
    });
    await registry.processPatientTurn(input('turn-2'), async ({ revealedFactIds }) => {
      assert.deepEqual(revealedFactIds, ['healthy_coping.facts.0']);
      return { replyText: 'I am still worried.', revealedFactIds: [], recovered: false };
    });
    assert.deepEqual(firstContext, []);
    const snapshot = registry.getSessionSnapshot('session-1', caseConfig.meta.caseId);
    assert.equal('revealedFactIds' in snapshot, false);
    assert.equal('revealedFactIds' in snapshot.transcript[1], false);
  });

  it('expires and scrubs an abandoned active session deterministically', async () => {
    const { registry, advance } = expiringSetup({ activeTtlMs: 100 });
    await registry.processPatientTurn(input('turn-1'), async () => reply);
    const retained = registry.sessions.get('session-1');
    assert.equal(retained.transcript.length, 2);
    assert.equal(retained.turnsByClientId.size, 1);

    advance(101);
    assert.equal(registry.pruneExpired(), 1);
    assert.equal(registry.sessions.has('session-1'), false);
    assert.equal(retained.transcript.length, 0);
    assert.equal(retained.turnsByClientId.size, 0);
    assert.equal(retained.caseConfig, undefined);
    assert.throws(
      () => registry.getSessionSnapshot('session-1', caseConfig.meta.caseId),
      (err) => err.code === 'SESSION_NOT_FOUND' && err.status === 404,
    );
  });

  it('clears the scheduled expiry when explicitly deleted', () => {
    const { registry, clearedTimers } = expiringSetup();
    const retained = registry.sessions.get('session-1');
    const timerId = retained.expiryTimer.id;
    registry.deleteSession('session-1');
    assert.equal(registry.sessions.has('session-1'), false);
    assert.ok(clearedTimers.includes(timerId));
    assert.equal(retained.caseConfig, undefined);
  });
});
