import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestResultRecovery } from './latest-result-recovery.mjs';

function environment() {
  const data = new Map();
  const tails = new Map();
  const storage = {
    failRead: false, failWrite: false,
    getItem(key) { if (this.failRead) throw new Error('denied'); return data.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('quota'); data.set(key, value); },
  };
  const locks = {
    request(name, options, operation) {
      assert.equal(options.mode, 'exclusive');
      const pending = (tails.get(name) ?? Promise.resolve()).then(operation);
      tails.set(name, pending.catch(() => {}));
      return pending;
    },
  };
  const options = { storage, locks, ownerId: 'verified-user-A', now: () => '2026-11-04T03:00:00.000Z' };
  return { data, storage, locks, options, service: createLatestResultRecovery(options) };
}
function snapshot(code = 'TEST-001', quantity = 10) {
  return {
    parsed: { items: [{ product_code: code, manufacturer: 'test', entries: [{ original_formula: '2.5 × 4', length_m: 2.5, quantity: 4, subtotal_m: 10 }], total_m: 10, order_quantity: quantity }] },
    editorState: { originalItems: [{ product_code: code, length_m: 2.5 }], overrides: { repeatCm: '64', enabled: true, perRow: { 'row-1': false } }, manualOrderQuantities: { [code]: quantity }, collapsedCodes: [code] },
    context: { siteName: 'テスト現場', sourceImageRefs: ['fake-reference-only'] },
  };
}
async function save(service, id = 'upload-1', value = snapshot()) {
  const started = await service.begin(id);
  assert.equal(started.status, 'started');
  const saved = await service.complete(started.token, value);
  assert.equal(saved.status, 'saved');
  return saved.latest;
}

test('empty storage restores nothing without creating a history', async () => {
  const { service, data } = environment();
  assert.deepEqual(await service.restore(), { status: 'restored', latest: null, pending: null });
  assert.equal(data.size, 0);
});
test('completed parsed results and all explicit editor state survive service recreation', async () => {
  const { service, options } = environment();
  const value = snapshot();
  const latest = await save(service, 'upload-1', value);
  const reopened = await createLatestResultRecovery(options).restore();
  assert.deepEqual(reopened.latest, latest);
  assert.deepEqual(reopened.latest.snapshot, value);
});
test('edits including code, quantities, original basis and toggle settings restore', async () => {
  const { service, options } = environment();
  const initial = await save(service);
  const edited = snapshot('TEST-002', 14);
  edited.editorState.overrides.enabled = false;
  edited.context.siteName = '編集済み';
  const result = await service.edit(initial.token, initial.revision, edited);
  assert.equal(result.status, 'saved');
  assert.equal(result.latest.revision, 2);
  assert.deepEqual((await createLatestResultRecovery(options).restore()).latest.snapshot, edited);
});
test('next upload preserves last result while pending and after failure', async () => {
  const { service } = environment();
  const previous = await save(service);
  const next = await service.begin('upload-2');
  assert.deepEqual((await service.restore()).latest, previous);
  assert.deepEqual((await service.restore()).pending.generation, next.token.generation);
  assert.equal((await service.fail(next.token)).status, 'preserved');
  assert.deepEqual((await service.restore()).latest, previous);
});
test('only next successful upload replaces result and overwrites one key', async () => {
  const { service, data } = environment();
  await save(service, 'upload-1', snapshot('OLD'));
  for (let i = 2; i <= 30; i++) await save(service, `upload-${i}`, snapshot(`NEW-${i}`));
  assert.equal(data.size, 1);
  const raw = data.get(service.key);
  assert.ok(!raw.includes('OLD'));
  assert.ok(!raw.includes('NEW-29'));
  assert.equal((await service.restore()).latest.snapshot.parsed.items[0].product_code, 'NEW-30');
});
test('out-of-order successes and failures cannot replace or clear newer uploads', async () => {
  const { service } = environment();
  const a = await service.begin('A');
  const b = await service.begin('B');
  assert.equal((await service.complete(a.token, snapshot('A'))).status, 'ignored');
  assert.equal((await service.fail(a.token)).status, 'ignored');
  assert.equal((await service.complete(b.token, snapshot('B'))).status, 'saved');
  assert.equal((await service.restore()).latest.snapshot.parsed.items[0].product_code, 'B');
});
test('repeated completion cannot undo manual edits', async () => {
  const { service } = environment();
  const first = await save(service);
  const edited = await service.edit(first.token, 1, snapshot('EDITED', 15));
  assert.equal((await service.complete(first.token, snapshot())).status, 'ignored');
  assert.deepEqual((await service.restore()).latest, edited.latest);
});
test('stale edit cannot alter a newly completed result', async () => {
  const { service } = environment();
  const old = await save(service);
  const current = await save(service, 'upload-2', snapshot('NEW'));
  assert.equal((await service.edit(old.token, old.revision, snapshot('STALE'))).code, 'result-replaced');
  assert.deepEqual((await service.restore()).latest, current);
});
test('concurrent tabs serialize edits and return a revision conflict', async () => {
  const { service, options } = environment();
  const initial = await save(service);
  const secondTab = createLatestResultRecovery(options);
  const results = await Promise.all([
    service.edit(initial.token, 1, snapshot('EDIT-A')),
    secondTab.edit(initial.token, 1, snapshot('EDIT-B')),
  ]);
  assert.deepEqual(results.map((x) => x.status), ['saved', 'conflict']);
  assert.equal(results[1].latest.snapshot.parsed.items[0].product_code, 'EDIT-A');
});
test('pending upload is recoverable after reload but no network is started', async () => {
  const { service, options } = environment();
  const prior = await save(service);
  const next = await service.begin('server-job-2');
  const restored = await createLatestResultRecovery(options).restore();
  assert.deepEqual(restored.latest, prior);
  assert.equal(restored.pending.operationId, 'server-job-2');
  assert.equal((await createLatestResultRecovery(options).complete(next.token, snapshot('RESUMED'))).status, 'saved');
});
test('failed atomic write leaves the prior raw record unchanged', async () => {
  const { service, storage, data } = environment();
  await save(service);
  const next = await service.begin('upload-2');
  const before = data.get(service.key);
  storage.failWrite = true;
  assert.equal((await service.complete(next.token, snapshot('NEW'))).code, 'storage-unavailable');
  assert.equal(data.get(service.key), before);
  storage.failWrite = false;
  assert.equal((await service.complete(next.token, snapshot('NEW'))).status, 'saved');
});
test('failed edit and failed begin preserve previously saved results', async () => {
  const { service, storage, data } = environment();
  const first = await save(service);
  const before = data.get(service.key);
  storage.failWrite = true;
  assert.equal((await service.edit(first.token, 1, snapshot('EDIT'))).status, 'blocked');
  assert.equal((await service.begin('new')).status, 'blocked');
  assert.equal(data.get(service.key), before);
});
test('missing Web Locks or unavailable storage fails closed', async () => {
  const { options, storage, data } = environment();
  assert.equal((await createLatestResultRecovery({ ...options, locks: undefined }).begin('new')).code, 'exclusive-lock-unavailable');
  storage.failRead = true;
  assert.equal((await createLatestResultRecovery(options).restore()).code, 'storage-unavailable');
  assert.equal((await createLatestResultRecovery({ ...options, storage: null }).restore()).code, 'storage-unavailable');
  assert.equal(data.size, 0);
});
test('different verified accounts cannot accidentally restore each other through this API', async () => {
  const { service, options } = environment();
  await save(service);
  const other = createLatestResultRecovery({ ...options, ownerId: 'verified-user-B' });
  assert.equal((await other.restore()).latest, null);
  assert.notEqual(service.key, other.key);
});
test('owner mismatch, corrupt data and unknown versions are not overwritten', async () => {
  for (const raw of ['{broken', '{"schemaVersion":2}', JSON.stringify({ schemaVersion: 1, ownerId: 'other', generation: 0, pending: null, latest: null })]) {
    const { service, data } = environment();
    data.set(service.key, raw);
    assert.equal((await service.restore()).status, 'blocked');
    assert.equal((await service.begin('new')).status, 'blocked');
    assert.equal(data.get(service.key), raw);
  }
});
test('empty or malformed new results never replace the previous successful result', async () => {
  const { service } = environment();
  const first = await save(service);
  const next = await service.begin('upload-2');
  for (const bad of [null, {}, { parsed: { items: [] }, editorState: {}, context: {} }, { ...snapshot(), parsed: { items: [{}] } }]) {
    assert.equal((await service.complete(next.token, bad)).status, 'blocked');
    assert.deepEqual((await service.restore()).latest, first);
  }
});
test('an explicit edit may remove all items and still restore editor state', async () => {
  const { service } = environment();
  const first = await save(service);
  const empty = snapshot(); empty.parsed.items = [];
  assert.equal((await service.edit(first.token, 1, empty)).status, 'saved');
  assert.deepEqual((await service.restore()).latest.snapshot.parsed.items, []);
});
test('oversize snapshot is rejected without altering the last result or pending job', async () => {
  const { options, data } = environment();
  const service = createLatestResultRecovery({ ...options, maxBytes: 2048 });
  const first = await save(service);
  const next = await service.begin('upload-2');
  const before = data.get(service.key);
  const large = snapshot(); large.context.note = 'あ'.repeat(2048);
  assert.equal((await service.complete(next.token, large)).code, 'snapshot-too-large');
  assert.equal(data.get(service.key), before);
  assert.deepEqual((await service.restore()).latest, first);
});
test('non-JSON values, sparse arrays, cyclic data and unsafe keys are rejected', async () => {
  const { service } = environment();
  const next = await service.begin('upload-1');
  const cyclic = {}; cyclic.self = cyclic;
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 'lost' });
  const accessor = {}; Object.defineProperty(accessor, 'read', { get: () => 'x', enumerable: true });
  const values = [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Set(['x']), cyclic, Array(2), hidden, accessor, JSON.parse('{"__proto__":{"x":1}}')];
  for (const value of values) {
    const bad = snapshot(); bad.editorState.extra = value;
    assert.equal((await service.complete(next.token, bad)).status, 'blocked');
  }
  assert.equal((await service.restore()).latest, null);
});
test('input, token and returned values are detached from stored state', async () => {
  const { service } = environment();
  const started = await service.begin('upload-1');
  const value = snapshot('ORIGINAL');
  const pending = service.complete(started.token, value);
  value.parsed.items[0].product_code = 'CHANGED';
  started.token.generation = 999;
  const saved = await pending;
  assert.equal(saved.status, 'saved');
  saved.latest.snapshot.parsed.items[0].product_code = 'RETURN-CHANGED';
  assert.equal((await service.restore()).latest.snapshot.parsed.items[0].product_code, 'ORIGINAL');
});
test('reusing an operation id still receives a new generation', async () => {
  const { service } = environment();
  const first = await service.begin('same');
  const second = await service.begin('same');
  assert.notEqual(first.token.generation, second.token.generation);
  assert.equal((await service.complete(first.token, snapshot())).status, 'ignored');
  assert.equal((await service.complete(second.token, snapshot())).status, 'saved');
});
test('editing previous result during a new upload does not remove pending metadata', async () => {
  const { service } = environment();
  const first = await save(service);
  const next = await service.begin('upload-2');
  assert.equal((await service.edit(first.token, 1, snapshot('EDITED'))).status, 'saved');
  const state = await service.restore();
  assert.equal(state.pending.operationId, next.token.operationId);
  assert.equal(state.latest.snapshot.parsed.items[0].product_code, 'EDITED');
  assert.equal((await service.complete(next.token, snapshot('NEXT'))).status, 'saved');
});
test('invalid numeric fields fail closed instead of persisting partial or changed values', async () => {
  const { service } = environment();
  const started = await service.begin('upload-1');
  for (const value of [-1, NaN, Infinity, '10', null]) {
    const bad = snapshot(); bad.parsed.items[0].order_quantity = value;
    assert.equal((await service.complete(started.token, bad)).status, 'blocked');
  }
});
test('invalid configuration and generation overflow are explicit failures', async () => {
  const { service, options, data } = environment();
  assert.throws(() => createLatestResultRecovery({ ...options, ownerId: '' }));
  assert.throws(() => createLatestResultRecovery({ ...options, maxBytes: 1 }));
  data.set(service.key, JSON.stringify({ schemaVersion: 1, ownerId: options.ownerId, generation: Number.MAX_SAFE_INTEGER, pending: null, latest: null }));
  assert.equal((await service.begin('new')).code, 'generation-overflow');
});
test('array hidden properties are rejected rather than silently discarded', async () => {
  const { service } = environment();
  const started = await service.begin('upload-1');
  const value = snapshot();
  value.editorState.hiddenArray = [];
  Object.defineProperty(value.editorState.hiddenArray, 'hidden', { value: 'lost' });
  assert.equal((await service.complete(started.token, value)).code, 'unsupported-array-property');
});
test('two tabs with interleaved starts, reload, stale failure and stale completion preserve newest work', async () => {
  const { service, options } = environment();
  const previous = await save(service);
  const secondTab = createLatestResultRecovery(options);
  const [first, second] = await Promise.all([service.begin('tab-1'), secondTab.begin('tab-2')]);
  const reopened = createLatestResultRecovery(options);
  assert.deepEqual((await reopened.restore()).latest, previous);
  assert.equal((await reopened.restore()).pending.operationId, 'tab-2');
  assert.equal((await service.fail(first.token)).status, 'ignored');
  assert.equal((await service.complete(first.token, snapshot('OLD'))).status, 'ignored');
  assert.equal((await reopened.complete(second.token, snapshot('NEW'))).status, 'saved');
  assert.equal((await secondTab.restore()).latest.snapshot.parsed.items[0].product_code, 'NEW');
});
test('failed fail-save preserves pending and latest, and can be retried', async () => {
  const { service, data, storage } = environment();
  await save(service);
  const next = await service.begin('new');
  const before = data.get(service.key);
  storage.failWrite = true;
  assert.equal((await service.fail(next.token)).status, 'blocked');
  assert.equal(data.get(service.key), before);
  storage.failWrite = false;
  assert.equal((await service.fail(next.token)).status, 'preserved');
  assert.equal((await service.restore()).pending, null);
});
test('revision overflow does not alter saved data', async () => {
  const { service, data } = environment();
  const first = await save(service);
  const state = JSON.parse(data.get(service.key));
  state.latest.revision = Number.MAX_SAFE_INTEGER;
  const before = JSON.stringify(state); data.set(service.key, before);
  assert.equal((await service.edit(first.token, Number.MAX_SAFE_INTEGER, snapshot('NEW'))).code, 'revision-overflow');
  assert.equal(data.get(service.key), before);
});
test('corrupt envelope fields block all writes without resetting existing data', async () => {
  const mutations = [
    (s) => { delete s.pending; },
    (s) => { s.pending = { generation: 999, operationId: 'bad', startedAt: 'now' }; },
    (s) => { s.latest.token = null; },
    (s) => { s.latest.revision = -1; },
    (s) => { s.latest.snapshot.editorState = []; },
    (s) => { s.latest.snapshot.parsed.items[0].total_m = -1; },
  ];
  for (const mutate of mutations) {
    const { service, data } = environment();
    const first = await save(service);
    const state = JSON.parse(data.get(service.key)); mutate(state);
    const before = JSON.stringify(state); data.set(service.key, before);
    assert.equal((await service.restore()).status, 'blocked');
    assert.equal((await service.begin('new')).status, 'blocked');
    assert.equal((await service.complete(first.token, snapshot())).status, 'blocked');
    assert.equal((await service.edit(first.token, 1, snapshot())).status, 'blocked');
    assert.equal((await service.fail(first.token)).status, 'blocked');
    assert.equal(data.get(service.key), before);
  }
});
test('already oversized saved data cannot be silently replaced by smaller data', async () => {
  const { options, data } = environment();
  const service = createLatestResultRecovery({ ...options, maxBytes: 2048 });
  const first = await save(service);
  const state = JSON.parse(data.get(service.key)); state.latest.snapshot.context.large = 'x'.repeat(3000);
  const before = JSON.stringify(state); data.set(service.key, before);
  for (const operation of [() => service.restore(), () => service.begin('new'), () => service.complete(first.token, snapshot()), () => service.edit(first.token, 1, snapshot()), () => service.fail(first.token)]) {
    assert.equal((await operation()).code, 'stored-data-invalid');
    assert.equal(data.get(service.key), before);
  }
});
test('a stale malformed completion is blocked, but never changes current result', async () => {
  const { service } = environment();
  const first = await save(service);
  const second = await save(service, 'second', snapshot('NEW'));
  assert.equal((await service.complete(first.token, {})).status, 'blocked');
  assert.deepEqual((await service.restore()).latest, second);
});
