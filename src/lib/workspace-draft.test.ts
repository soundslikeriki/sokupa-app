import test from "node:test";
import assert from "node:assert/strict";
import { retainDeferredJobResult, readWorkspaceDraft, archiveWorkspaceDraft, workspaceContainsJobResult, workspaceWouldBeReplacedByResult, switchWorkspaceDraft, listWorkspaceArchives, assertWorkspaceArchiveCurrent, prepareWorkspaceSwitch, type WorkspaceDraft } from "./workspace-draft";

test("workspace round-trip retains edits, original measurements, repeat settings and order draft", () => {
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 5.4, order_quantity: 7, entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }] };
  const state = { version: 1, siteName: "Synthetic site", parsed: { items: [{ ...original, total_m: 6, repeat_cm: 60, manual_order_quantity: 10, order_quantity: 10, entries: [{ ...original.entries[0], repeat_enabled: true, subtotal_m: 6 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [{ id: "draft-1", productCode: "VS2067", quantity: 10, unit: "m", sourceType: "dimension", sourceLabel: "寸法計算" }] };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.parsed!.items[0].entries[0].length_m, 2.7);
  assert.equal(restored.originalParsed!.items[0].total_m, 5.4);
});

test("workspace retains explicit row-height precedence without changing legacy common-height drafts", () => {
  const entry = { original_formula: "0.7×2", length_m: 0.7, quantity: 2, subtotal_m: 2.4, repeat_enabled: true, repeat_use_row_length: true };
  const state = { version: 1, siteName: "Synthetic", parsed: { items: [{ product_code: "SYN", manufacturer: "Test", repeat_cm: 60, repeat_height_m: 3.8, total_m: 6.6, order_quantity: 8, entries: [entry] }] }, orderDraftItems: [] };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.parsed!.items[0].entries[0].repeat_use_row_length, true);
  assert.equal(restored.parsed!.items[0].entries[0].length_m, 0.7);
  delete (entry as Partial<typeof entry>).repeat_use_row_length;
  assert.equal(readWorkspaceDraft(JSON.stringify(state)).parsed!.items[0].entries[0].repeat_use_row_length, undefined);
  for (const invalid of ["true", 1, null, {}]) {
    assert.throws(() => readWorkspaceDraft(JSON.stringify({ ...state, parsed: { items: [{ ...state.parsed.items[0], entries: [{ ...entry, repeat_use_row_length: invalid }] }] } })), /復元できません/);
  }
});

test("explicit job association survives reload; matching legacy OCR never proves identity", () => {
  const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 20, order_quantity: 23, entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }] };
  const state = { version: 1 as const, siteName: "Edited site", parsed: { items: [{ ...original, order_quantity: 46, total_m: 40, entries: [{ ...original.entries[0], quantity: 2, subtotal_m: 40 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [], resultJobId: id };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.equal(restored.parsed!.items[0].order_quantity, 46);
  assert.equal(workspaceContainsJobResult(restored, id), true);
  assert.equal(workspaceContainsJobResult(restored, other), false);
  const legacy = { ...state, resultJobId: undefined };
  assert.equal(workspaceContainsJobResult(legacy, id), false);
  assert.equal(workspaceContainsJobResult(legacy, other), false);
  assert.equal(workspaceContainsJobResult(null, id), false);
  assert.throws(() => readWorkspaceDraft(JSON.stringify({ ...state, resultJobId: "corrupt job ID" })));
});

test("corrupt, incomplete and unsupported drafts are rejected without rewriting input", () => {
  for (const text of ["bad json", "{}", '{"version":2}', '{"version":1,"siteName":"Test","parsed":{"items":[{}]},"orderDraftItems":[]}', '{"version":1,"siteName":"Test","parsed":null,"orderDraftItems":[{}]}']) assert.throws(() => readWorkspaceDraft(text));
});

test("invalid negative draft can be archived byte-for-byte; failures never replace the source", () => {
  const raw = '{"version":1,"parsed":{"items":[{"quantity":-1}]}}';
  const values = new Map([["draft", raw]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.throws(() => readWorkspaceDraft(raw));
  const backup = archiveWorkspaceDraft(storage, "draft", raw, "synthetic");
  assert.equal(storage.getItem(backup), raw);
  assert.equal(storage.getItem("draft"), raw);
  assert.throws(() => archiveWorkspaceDraft(storage, "draft", "older state", "another"));
  assert.throws(() => archiveWorkspaceDraft({ ...storage, setItem: () => { throw new Error("quota exceeded"); } }, "draft", raw, "failed"));
  assert.equal(storage.getItem("draft"), raw);
});

const snapshot = (id: string, siteName: string, quantity: number): WorkspaceDraft => {
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 20, order_quantity: 23, entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }] };
  return { version: 1, siteName, resultJobId: id, parsed: { items: [{ ...original, total_m: 20 * quantity, order_quantity: Math.ceil(23 * quantity), entries: [{ ...original.entries[0], quantity, subtotal_m: 20 * quantity }] }] }, originalParsed: { items: [original] }, orderDraftItems: [] };
};
const jobA = "00000000-0000-4000-8000-00000000000a", jobB = "00000000-0000-4000-8000-00000000000b";
const storageFor = (values: Map<string, string>) => ({
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  key: (index: number) => Array.from(values.keys())[index] ?? null,
  get length() { return values.size; },
});

test("different or unknown jobs need a choice even if their original OCR is identical", () => {
  const a = snapshot(jobA, "Edited A", 2);
  assert.equal(workspaceWouldBeReplacedByResult(a, jobA, "Server A"), false);
  assert.equal(workspaceWouldBeReplacedByResult(a, jobB, "Server B"), true);
  assert.equal(workspaceWouldBeReplacedByResult({ ...a, resultJobId: undefined }, jobB, "Server B"), true);
  assert.equal(workspaceWouldBeReplacedByResult({ ...a, parsed: null, originalParsed: null, siteName: "Server B" }, jobB, "Server B"), false);
  assert.equal(workspaceWouldBeReplacedByResult({ ...a, parsed: null, originalParsed: null }, jobB, null), true);
});

test("atomic switch retains the latest edited60m once and swaps rather than appending", () => {
  const key="workspace", a=snapshot(jobA,"A",1), editedA={...a,parsed:{items:[{...a.parsed!.items[0],order_quantity:60,manual_order_quantity:60}]}}, b=snapshot(jobB,"B",2);
  const values=new Map([[key,JSON.stringify(a,null,2)]]), storage=storageFor(values);
  let switched=switchWorkspaceDraft(storage,key,values.get(key)!,editedA,b,"same-ms");
  assert.equal(switched.draft.version,2); assert.equal(switched.archives.length,1); assert.equal(switched.archives[0].draft?.parsed?.items[0].order_quantity,60);
  assert.equal(switched.draft.recentDraft?.revision,1); assert.equal(values.size,1);
  for(let n=0;n<50;n++) {
    const previous=listWorkspaceArchives(storage,key)[0];assertWorkspaceArchiveCurrent(storage,key,previous);
    const outgoing=JSON.parse(JSON.stringify(switched.draft));delete outgoing.recentDraft;outgoing.version=1;
    switched=switchWorkspaceDraft(storage,key,switched.raw,switched.draft,previous.draft!,"same-ms");
    assert.deepEqual(readWorkspaceDraft(switched.draft.recentDraft!.raw),outgoing);
    assert.equal(values.size,1);assert.equal(listWorkspaceArchives(storage,key).length,1);assert.equal(switched.draft.recentDraft?.revision,n+2);
    assert.equal(readWorkspaceDraft(switched.draft.recentDraft!.raw).recentDraft,undefined);
  }
});

test("quota and ignored writes preserve both the old active and previous value", () => {
  const key="workspace", a=snapshot(jobA,"A",2), b=snapshot(jobB,"B",1), initial=prepareWorkspaceSwitch(a,b), raw=JSON.stringify(initial);
  const values=new Map([[key,raw]]),storage=storageFor(values);
  for(const setItem of [()=>{throw Error("quota");},()=>{}]) {
    assert.throws(()=>switchWorkspaceDraft({...storage,setItem},key,raw,initial,a));assert.equal(values.get(key),raw);assert.equal(values.size,1);
  }
  values.set(key,"changed by another tab");assert.throws(()=>switchWorkspaceDraft(storage,key,raw,initial,a),/別の画面/);assert.equal(values.get(key),"changed by another tab");
});

test("readback failure after atomic commit keeps the outgoing edit recoverable on reload", () => {
  const key="workspace",a=snapshot(jobA,"A",2),b=snapshot(jobB,"B",1),raw=JSON.stringify(a),values=new Map([[key,raw]]),storage=storageFor(values);let bad=false;
  assert.throws(()=>switchWorkspaceDraft({...storage,setItem:(key,value)=>{storage.setItem(key,value);bad=true;},getItem:key=>{if(bad){bad=false;return "unverified";}return storage.getItem(key);}},key,raw,a,b),/保存を確認/);
  const reloaded=readWorkspaceDraft(values.get(key)!);assert.equal(reloaded.resultJobId,jobB);assert.equal(readWorkspaceDraft(reloaded.recentDraft!.raw).resultJobId,jobA);assert.equal(values.size,1);
});

test("failed primary write retries without new keys; stale revision/owner/source cannot be reused", () => {
  const key="workspace",a=snapshot(jobA,"A",2),b=snapshot(jobB,"B",1),raw=JSON.stringify(a),values=new Map([[key,raw]]),storage=storageFor(values);let fail=true;
  const flaky={...storage,setItem:(key:string,value:string)=>{if(fail)throw Error("quota");storage.setItem(key,value);}};
  assert.throws(()=>switchWorkspaceDraft(flaky,key,raw,a,b));fail=false;const first=switchWorkspaceDraft(flaky,key,raw,a,b);assert.equal(values.size,1);
  const oldSelection=listWorkspaceArchives(storage,key)[0];assertWorkspaceArchiveCurrent(storage,key,oldSelection);
  const second=switchWorkspaceDraft(storage,key,first.raw,first.draft,a);
  assert.throws(()=>assertWorkspaceArchiveCurrent(storage,key,oldSelection),/変わりました/);
  assert.throws(()=>assertWorkspaceArchiveCurrent(storage,"other-owner",oldSelection));
  assert.throws(()=>switchWorkspaceDraft(storage,key,second.raw,{...second.draft,recentDraft:undefined},b),/変わりました/);
});

test("postponed result is verified and retained independently of the edited workspace", () => {
  const values = new Map([["draft", "exact edited workspace bytes"]]), storage = storageFor(values);
  const job = "00000000-0000-4000-8000-00000000000a";
  const result = { items: [{ product_code: "A", manufacturer: "Synthetic", entries: [], total_m: 20, order_quantity: 23 }] };
  const retained = retainDeferredJobResult(storage, "draft", job, "Remote A", result);
  assert.equal(values.get("draft"), "exact edited workspace bytes");
  assert.equal(readWorkspaceDraft(retained.raw).resultJobId, job);
  assert.deepEqual(readWorkspaceDraft(retained.raw).parsed, result);
  assert.deepEqual(readWorkspaceDraft(retained.raw).orderDraftItems, []);
  assert.equal(retainDeferredJobResult(storage, "draft", job, "Remote A", result).raw, retained.raw);
  assert.equal(values.size, 2);
  retainDeferredJobResult(storage, "other-owner", job, "Remote A", result);
  assert.equal(values.size, 3);
});

test("postponed result failures preserve the workspace and existing archive bytes", () => {
  const values = new Map([["draft", "exact edited workspace bytes"]]), storage = storageFor(values);
  const job = "00000000-0000-4000-8000-00000000000a", result = { items: [] };
  assert.throws(() => retainDeferredJobResult({ ...storage, setItem: () => { throw Error("quota"); } }, "draft", job, "A", result));
  assert.throws(() => retainDeferredJobResult({ ...storage, getItem: (key) => key.includes(":recovery:") && values.has(key) ? "wrong readback" : storage.getItem(key) }, "draft", job, "A", result));
  const archiveKey = `draft:recovery:result:${job}`; values.set(archiveKey, "invalid existing raw");
  assert.throws(() => retainDeferredJobResult(storage, "draft", job, "A", result));
  assert.equal(values.get(archiveKey), "invalid existing raw"); assert.equal(values.get("draft"), "exact edited workspace bytes");
  assert.throws(() => retainDeferredJobResult(storage, "draft", "invalid-id", "A", result));
});
