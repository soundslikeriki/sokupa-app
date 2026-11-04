/** Verified prototype core, integrated through typed workspace adapters. No network access. */
const VERSION = 1;
const DEFAULT_MAX_BYTES = 512 * 1024;
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 256;
const safeInt = (x) => Number.isSafeInteger(x) && x >= 0;

class Invalid extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Reject unsupported data rather than silently dropping fields or changing NaN to null.
function jsonCopy(value) {
  const ancestors = new Set();
  function check(x, depth) {
    if (depth > 40) throw new Invalid('snapshot-too-deep');
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
    if (typeof x === 'number' && Number.isFinite(x)) return;
    if (!record(x) && !Array.isArray(x)) throw new Invalid('unsupported-snapshot-value');
    if (Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== Array.prototype && Object.getPrototypeOf(x) !== null) throw new Invalid('unsupported-snapshot-object');
    if (ancestors.has(x)) throw new Invalid('cyclic-snapshot');
    ancestors.add(x);
    if (Reflect.ownKeys(x).some((key) => typeof key === 'symbol')) throw new Invalid('unsupported-snapshot-key');
    const descriptors = Object.getOwnPropertyDescriptors(x);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) throw new Invalid('unsupported-snapshot-accessor');
    }
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        if (!Object.hasOwn(x, i)) throw new Invalid('sparse-snapshot-array');
        check(x[i], depth + 1);
      }
      if (Object.getOwnPropertyNames(x).some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= x.length))) throw new Invalid('unsupported-array-property');
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) throw new Invalid('unsupported-snapshot-property');
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Invalid('unsafe-snapshot-key');
        check(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(x);
  }
  check(value, 0);
  return JSON.parse(JSON.stringify(value));
}

function snapshotCopy(snapshot, requireItems) {
  const copy = jsonCopy(snapshot);
  if (!record(copy) || !record(copy.parsed) || !Array.isArray(copy.parsed.items) || (requireItems && !copy.parsed.items.length)) throw new Invalid('snapshot-invalid');
  if (!record(copy.editorState) || !record(copy.context)) throw new Invalid('snapshot-invalid');
  // Check the known old-baseline core only. Latest application must add its own schema.
  for (const item of copy.parsed.items) {
    if (!record(item) || !text(item.product_code) || !Array.isArray(item.entries)) throw new Invalid('item-invalid');
    for (const key of ['total_m', 'order_quantity']) {
      if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) throw new Invalid('item-invalid');
    }
    for (const entry of item.entries) {
      if (!record(entry) || typeof entry.original_formula !== 'string') throw new Invalid('entry-invalid');
      for (const key of ['length_m', 'quantity', 'subtotal_m']) {
        if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] < 0) throw new Invalid('entry-invalid');
      }
    }
  }
  return copy;
}

function matches(a, b) {
  return record(a) && record(b) && a.generation === b.generation && a.operationId === b.operationId;
}

/**
 * storage: synchronous getItem/setItem with atomic setItem failure semantics.
 * locks: Web Locks-compatible request(name, { mode: 'exclusive' }, callback).
 * Every writer MUST use this service and this lock. Missing lock support fails closed.
 * ownerId must come from a verified signed-in session, never a user-editable form.
 */
export function createLatestResultRecovery({ ownerId, storage, locks, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date().toISOString() }) {
  if (!text(ownerId)) throw new Invalid('owner-required');
  if (!safeInt(maxBytes) || maxBytes < 1024) throw new Invalid('size-limit-invalid');
  const key = `sokupa:latest-result:v${VERSION}:${encodeURIComponent(ownerId)}`;
  const lockName = `${key}:write`;
  const bytes = (raw) => new TextEncoder().encode(raw).byteLength;
  const fresh = () => ({ schemaVersion: VERSION, ownerId, generation: 0, pending: null, latest: null });
  const timestamp = () => {
    const value = now();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Invalid('clock-invalid');
    return value;
  };
  function decode(raw) {
    if (raw === null) return fresh();
    if (typeof raw !== 'string' || bytes(raw) > maxBytes) throw new Invalid('stored-data-invalid');
    let state;
    try { state = JSON.parse(raw); } catch { throw new Invalid('stored-data-invalid'); }
    if (!record(state) || state.schemaVersion !== VERSION) throw new Invalid('stored-version-unsupported');
    if (state.ownerId !== ownerId) throw new Invalid('stored-owner-mismatch');
    if (!safeInt(state.generation) || !Object.hasOwn(state, 'pending') || !Object.hasOwn(state, 'latest')) throw new Invalid('stored-data-invalid');
    if (state.pending !== null && (!record(state.pending) || !text(state.pending.operationId) || state.pending.generation !== state.generation || !text(state.pending.startedAt))) throw new Invalid('stored-data-invalid');
    if (state.latest !== null) {
      if (!record(state.latest) || !record(state.latest.token) || !safeInt(state.latest.token.generation) || state.latest.token.generation < 1 || state.latest.token.generation > state.generation || !text(state.latest.token.operationId) || !safeInt(state.latest.revision) || state.latest.revision < 1 || !text(state.latest.updatedAt)) throw new Invalid('stored-data-invalid');
      if (state.pending && state.latest.token.generation >= state.pending.generation) throw new Invalid('stored-data-invalid');
      snapshotCopy(state.latest.snapshot, false);
    }
    return state;
  }
  function write(state) {
    const raw = JSON.stringify(state);
    if (bytes(raw) > maxBytes) throw new Invalid('snapshot-too-large');
    // No remove-before-write, backup keys, result histories, or accumulated images.
    storage.setItem(key, raw);
  }
  function view(state) {
    return jsonCopy({ status: 'restored', latest: state.latest, pending: state.pending });
  }
  async function run(operation) {
    if (!locks || typeof locks.request !== 'function') return { status: 'blocked', code: 'exclusive-lock-unavailable' };
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return { status: 'blocked', code: 'storage-unavailable' };
    try {
      return await locks.request(lockName, { mode: 'exclusive' }, () => operation(decode(storage.getItem(key))));
    } catch (error) {
      return { status: 'blocked', code: error instanceof Invalid ? error.code : 'storage-unavailable' };
    }
  }
  // Copy before waiting for a lock so subsequent caller mutations cannot alter the request.
  function prepare(snapshot, requireItems) {
    try { return { snapshot: snapshotCopy(snapshot, requireItems) }; }
    catch (error) { return { error: { status: 'blocked', code: error instanceof Invalid ? error.code : 'snapshot-invalid' } }; }
  }
  return {
    key,
    restore: () => run(view),
    begin(operationId) {
      if (!text(operationId)) return Promise.resolve({ status: 'blocked', code: 'operation-id-required' });
      return run((state) => {
        if (state.generation === Number.MAX_SAFE_INTEGER) throw new Invalid('generation-overflow');
        const token = { generation: state.generation + 1, operationId };
        state.generation = token.generation;
        state.pending = { ...token, startedAt: timestamp() };
        write(state);
        return { status: 'started', token };
      });
    },
    complete(token, snapshot) {
      const input = prepare(snapshot, true);
      if (input.error) return Promise.resolve(input.error);
      const expected = record(token) ? { generation: token.generation, operationId: token.operationId } : null;
      return run((state) => {
        if (!matches(state.pending, expected)) return { status: 'ignored', code: 'stale-or-already-completed' };
        state.latest = { token: expected, revision: 1, updatedAt: timestamp(), snapshot: input.snapshot };
        state.pending = null;
        write(state);
        return { status: 'saved', latest: jsonCopy(state.latest) };
      });
    },
    edit(token, expectedRevision, snapshot) {
      const input = prepare(snapshot, false);
      if (input.error) return Promise.resolve(input.error);
      const expected = record(token) ? { generation: token.generation, operationId: token.operationId } : null;
      return run((state) => {
        if (!state.latest || !matches(state.latest.token, expected)) return { status: 'ignored', code: 'result-replaced' };
        if (state.latest.revision !== expectedRevision) return { status: 'conflict', code: 'revision-changed', latest: jsonCopy(state.latest) };
        if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new Invalid('revision-overflow');
        state.latest = { token: expected, revision: expectedRevision + 1, updatedAt: timestamp(), snapshot: input.snapshot };
        write(state);
        return { status: 'saved', latest: jsonCopy(state.latest) };
      });
    },
    fail(token) {
      const expected = record(token) ? { generation: token.generation, operationId: token.operationId } : null;
      return run((state) => {
        if (!matches(state.pending, expected)) return { status: 'ignored', code: 'stale-or-already-completed' };
        state.pending = null;
        write(state);
        return { status: 'preserved' };
      });
    },
  };
}
