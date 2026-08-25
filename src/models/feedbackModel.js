// Only in-flight End operations are coordinated here. Completed results live on
// the ActiveSessionRegistry record, so this module creates no completion store.
const operationsByRegistry = new WeakMap();

function operationsFor(registry) {
  let operations = operationsByRegistry.get(registry);
  if (!operations) {
    operations = new Map();
    operationsByRegistry.set(registry, operations);
  }
  return operations;
}

/** Coalesce concurrent End requests for the same registry/session. */
export function runEndOperationOnce(registry, sessionId, operation) {
  const operations = operationsFor(registry);
  const existing = operations.get(sessionId);
  if (existing) return existing;

  const pending = Promise.resolve().then(operation);
  operations.set(sessionId, pending);
  pending.finally(() => {
    if (operations.get(sessionId) === pending) operations.delete(sessionId);
  }).catch(() => {});
  return pending;
}

export function isEndOperationInFlight(registry, sessionId) {
  return operationsFor(registry).has(sessionId);
}
