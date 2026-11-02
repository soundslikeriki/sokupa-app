import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspaceDraft, archiveWorkspaceDraft } from "./workspace-draft";

test("workspace round-trip retains edits, original measurements, repeat settings and order draft", () => {
  const original = { product_code: "VS2067", manufacturer: "Test", total_m: 5.4, order_quantity: 7, entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }] };
  const state = { version: 1, siteName: "Synthetic site", parsed: { items: [{ ...original, total_m: 6, repeat_cm: 60, manual_order_quantity: 10, order_quantity: 10, entries: [{ ...original.entries[0], repeat_enabled: true, subtotal_m: 6 }] }] }, originalParsed: { items: [original] }, orderDraftItems: [{ id: "draft-1", productCode: "VS2067", quantity: 10, unit: "m", sourceType: "dimension", sourceLabel: "寸法計算" }] };
  const restored = readWorkspaceDraft(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.parsed!.items[0].entries[0].length_m, 2.7);
  assert.equal(restored.originalParsed!.items[0].total_m, 5.4);
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
