import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspaceDraft, archiveWorkspaceDraft, workspaceContainsJobResult, workspaceWouldBeReplacedByResult, switchWorkspaceDraft, listWorkspaceArchives, type WorkspaceDraft } from "./workspace-draft";

test("workspace round-trip retains edits, original measurements, repeat settings and order draft", () => {
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 5.4, order_quantity: 7, entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }] };
  const state = { version: 1, siteName: "Synthetic site", parsed: { items: [{ ...original, total_m: 6, repeat_cm: 60, manual_order_quantity: 10, order_quantity: 10, entries: [{ ...original.entries[0], repeat_enabled: true, subtotal_m: 6 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [{ id: "draft-1", productCode: "VS2067", quantity: 10, unit: "m", sourceType: "dimension", sourceLabel: "寸法計算" }] };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.parsed!.items[0].entries[0].length_m, 2.7);
  assert.equal(restored.originalParsed!.items[0].total_m, 5.4);
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

test("switch and restore preserve both the exact original bytes and newer unsaved edits", () => {
  const key = "workspace", a = snapshot(jobA, "A", 2), editedA = snapshot(jobA, "Edited A", 3), b = snapshot(jobB, "B", 1), raw = JSON.stringify(a, null, 2);
  const values = new Map([[key, raw]]), storage = storageFor(values);
  const switched = switchWorkspaceDraft(storage, key, raw, editedA, b, "first");
  assert.equal(storage.getItem(key), JSON.stringify(b));
  assert.equal(switched.archives.length, 2);
  assert.equal(switched.archives[0].raw, raw);
  assert.deepEqual(readWorkspaceDraft(switched.archives[1].raw), editedA);
  switchWorkspaceDraft(storage, key, switched.raw, b, editedA, "restore");
  assert.deepEqual(readWorkspaceDraft(storage.getItem(key)!), editedA);
  assert.ok(listWorkspaceArchives(storage, key).some((entry) => entry.draft?.resultJobId === jobB));
  values.set("someone-else:recovery:secret", raw); values.set(key + ":recovery:old-invalid", "invalid legacy raw");
  assert.equal(listWorkspaceArchives(storage, key).some((entry) => entry.key.startsWith("someone-else")), false);
  assert.equal(listWorkspaceArchives(storage, key).find((entry) => entry.raw === "invalid legacy raw")?.draft, null);
});

test("failed archive writes/readbacks and changed source never replace the current workspace", () => {
  const key = "workspace", a = snapshot(jobA, "A", 2), b = snapshot(jobB, "B", 1), raw = JSON.stringify(a);
  const values = new Map([[key, raw]]), storage = storageFor(values);
  assert.throws(() => switchWorkspaceDraft({ ...storage, setItem: () => { throw new Error("quota"); } }, key, raw, a, b, "write-fail"));
  assert.equal(values.get(key), raw);
  assert.throws(() => switchWorkspaceDraft({ ...storage, getItem: (name) => name.includes(":recovery:") && values.has(name) ? "wrong readback" : storage.getItem(name) }, key, raw, a, b, "verify-fail"));
  assert.equal(values.get(key), raw);
  values.set(key, "changed by another tab");
  assert.throws(() => switchWorkspaceDraft(storage, key, raw, a, b, "source-changed"), /別の画面/);
  assert.equal(values.get(key), "changed by another tab");
});

test("a failed primary write can be retried without duplicating verified archives", () => {
  const key = "workspace", a = snapshot(jobA, "A", 2), b = snapshot(jobB, "B", 1), raw = JSON.stringify(a);
  const values = new Map([[key, raw]]), storage = storageFor(values); let failPrimary = true;
  const failing = { ...storage, setItem: (name: string, value: string) => { if (name === key && failPrimary) throw Error("quota"); storage.setItem(name, value); } };
  assert.throws(() => switchWorkspaceDraft(failing, key, raw, a, b, "retry")); assert.equal(values.get(key), raw);
  const count = values.size; failPrimary = false;
  switchWorkspaceDraft(failing, key, raw, a, b, "retry"); assert.equal(values.size, count); assert.deepEqual(readWorkspaceDraft(values.get(key)!), b);
});

test("a source change during archiving is kept and never overwritten", () => {
  const key = "workspace", a = snapshot(jobA, "A", 2), b = snapshot(jobB, "B", 1), raw = JSON.stringify(a);
  const values = new Map([[key, raw]]), storage = storageFor(values);
  assert.throws(() => switchWorkspaceDraft({ ...storage, setItem: (name, value) => { storage.setItem(name, value); if (name.includes(":recovery:")) values.set(key, "concurrent source"); } }, key, raw, a, b, "changed-midway"), /別の画面/);
  assert.equal(values.get(key), "concurrent source"); assert.ok(Array.from(values.entries()).some(([name, value]) => name.includes(":recovery:") && value === raw));
});
