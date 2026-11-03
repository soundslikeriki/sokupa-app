import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspaceDraft, archiveWorkspaceDraft, workspaceContainsJobResult } from "./workspace-draft";

test("workspace round-trip retains edits, original measurements, repeat settings and order draft", () => {
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 5.4, order_quantity: 7, entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }] };
  const state = { version: 1, siteName: "Synthetic site", parsed: { items: [{ ...original, total_m: 6, repeat_cm: 60, manual_order_quantity: 10, order_quantity: 10, entries: [{ ...original.entries[0], repeat_enabled: true, subtotal_m: 6 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [{ id: "draft-1", productCode: "VS2067", quantity: 10, unit: "m", sourceType: "dimension", sourceLabel: "寸法計算" }] };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.parsed!.items[0].entries[0].length_m, 2.7);
  assert.equal(restored.originalParsed!.items[0].total_m, 5.4);
});

test("job association survives reload and preserves old matching edits without matching a different job", () => {
  const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 20, order_quantity: 23, entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }] };
  const state = { version: 1 as const, siteName: "Edited site", parsed: { items: [{ ...original, order_quantity: 46, total_m: 40, entries: [{ ...original.entries[0], quantity: 2, subtotal_m: 40 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [], resultJobId: id };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.equal(restored.parsed!.items[0].order_quantity, 46);
  assert.equal(workspaceContainsJobResult(restored, id, state.originalParsed), true);
  assert.equal(workspaceContainsJobResult(restored, other, state.originalParsed), false);
  const legacy = { ...state, resultJobId: undefined };
  assert.equal(workspaceContainsJobResult(legacy, id, { items: [{ entries: original.entries, order_quantity: 23, total_m: 20, manufacturer: "Test", product_code: "VS2067" }] }), true);
  assert.equal(workspaceContainsJobResult(legacy, id, { items: [{ ...original, product_code: "DIFFERENT" }] }), false);
  assert.equal(workspaceContainsJobResult(null, id, state.originalParsed), false);
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
