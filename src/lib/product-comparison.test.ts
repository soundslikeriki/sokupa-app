import test from "node:test";
import assert from "node:assert/strict";
import { compareProduct, assessProductOrder } from "./product-comparison";
import { saveLatestWorkspaceSnapshot, restoreLatestWorkspaceSnapshot, rebuildLatestWorkspaceSnapshot } from "./latest-workspace";
import { replaceWorkspaceDraft, type WorkspaceDraft } from "./workspace-draft";
import { mergeParsedPayloads } from "./memo-calculation";
import type { MemoProductItem } from "../types";
import { findOriginalMemoEntry } from "./original-memo-entry";
import { readWorkspaceDraft } from "./workspace-draft";
const item: MemoProductItem = { product_code: "SYNTHETIC", manufacturer: "Synthetic", entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }, { original_formula: "3.8×1", length_m: 3.8, quantity: 1, subtotal_m: 3.8 }], total_m: 9.2, order_quantity: 11 };
const rows = [{ id: "a", length: 2.7, quantity: 2, active: true }, { id: "b", length: 3.8, quantity: 1, active: true }];
test("incomplete measurements never reuse the last valid number for sufficiency", async () => {
  const valid = compareProduct(item, rows, 60, "trim-included", "straight");
  for (const field of ["lengthInput", "quantityInput"] as const) {
    const comparison = compareProduct(item, [{ ...rows[0], [field]: "" }, rows[1]], 60, "trim-included", "straight");
    assert.equal(comparison.premisesAvailable, false);
    assert.equal(comparison.strict.totals.selectedM, null);
    assert.equal(comparison.reference!.totals.selectedM, null);
    assert.notEqual(comparison.fingerprint, valid.fingerprint);
    assert.equal(assessProductOrder(30, comparison.strict.totals.selectedM, false).showCheckmark, false);
  }
  const blank = { ...item, entries: [{ ...item.entries[0], length_input: "", quantity_input: "" }] };
  const draft: WorkspaceDraft = { version: 1, siteName: "Incomplete", parsed: { items: [blank] }, originalParsed: { items: [item] }, orderDraftItems: [] };
  assert.equal(readWorkspaceDraft(JSON.stringify(draft)).parsed!.items[0].entries[0].length_input, "");
  const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, raw: string) => { values.set(key, raw); } };
  await saveLatestWorkspaceSnapshot(storage, "owner", draft);
  assert.equal((await restoreLatestWorkspaceSnapshot(storage, "owner"))!.parsed!.items[0].entries[0].quantity_input, "");
});
test("row reset follows source identity after deletion and refuses ambiguous legacy matches", () => {
  const originals = item.entries.map((entry, index) => ({ ...entry, source_row_id: `image-${index}:row-0`, source_image_index: index }));
  const survivor = { ...originals[1], length_m: 9, quantity: 7 };
  assert.equal(findOriginalMemoEntry(originals, survivor), originals[1]);
  assert.equal(findOriginalMemoEntry(item.entries, { ...item.entries[1], length_m: 9 }), item.entries[1]);
  assert.equal(findOriginalMemoEntry([item.entries[1], { ...item.entries[1] }], item.entries[1]), undefined);
  assert.equal(findOriginalMemoEntry(originals, { ...survivor, source_row_id: "missing" }), undefined);
});
test("integrated repeat compares each height, restores source OFF and refuses double adjustment", () => {
  const on = compareProduct(item, rows, 60, "trim-included", "straight");
  assert.equal(on.strict.totals.selectedM, "10.2");
  assert.equal(on.strict.rows[0].selected.perStripM, "3"); assert.equal(on.strict.rows[1].selected.perStripM, "4.2");
  const off = compareProduct(item, rows.map(row => ({ ...row, active: false })), 60, "trim-included", "straight");
  assert.equal(off.strict.totals.selectedM, "9.2");
  const adjusted = compareProduct(item, rows, 60, "repeat-adjusted", "straight");
  assert.equal(adjusted.strict.totals.selectedM, null); assert.equal(adjusted.reference, null);
  assert.equal(compareProduct(item, rows, 60, "trim-included", "other").reference, null);
});
test("unknown premises never prove sufficiency, and measurement changes invalidate confirmation", () => {
  const unknown = compareProduct(item, rows, 60, "unconfirmed", "unconfirmed");
  assert.equal(unknown.premisesAvailable, false); assert.equal(assessProductOrder(20, unknown.reference!.totals.selectedM, false).showCheckmark, false);
  const valid = compareProduct(item, rows, 60, "trim-included", "straight");
  assert.equal(assessProductOrder(10, valid.strict.totals.selectedM, true).shortage, "0.2");
  assert.equal(assessProductOrder(11, valid.strict.totals.selectedM, true).showCheckmark, true);
  assert.notEqual(compareProduct(item, [{ ...rows[0], length: 2.8 }, rows[1]], 60, "trim-included", "straight").fingerprint, valid.fingerprint);
  assert.equal(compareProduct({ ...item, order_quantity: 20 }, rows, 60, "trim-included", "straight").fingerprint, valid.fingerprint);
});
test("image provenance survives same-product multi-image merge without inventing an owner", () => {
  const result = mergeParsedPayloads([{ items: [item] }, { items: [item] }]);
  assert.deepEqual(result.items[0].entries.map(row => row.source_image_index), [0,0,1,1]);
  assert.equal(new Set(result.items[0].entries.map(row => row.source_row_id)).size, 4);
});
test("fixed latest snapshot restores edits and stays bounded over repeated result replacement", async () => {
  const data = new Map<string,string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, raw: string) => { data.set(key,raw); } };
  let draft: WorkspaceDraft = { version: 1, siteName: "Edited", parsed: { items: [item] }, originalParsed: { items: [item] }, orderDraftItems: [], resultJobId: "00000000-0000-4000-8000-000000000001" };
  for (let i=1;i<=30;i++) { draft = { ...draft, resultJobId: `00000000-0000-4000-8000-${String(i).padStart(12,"0")}`, siteName: `Edited ${i}` }; await saveLatestWorkspaceSnapshot(storage,"verified-owner",draft); }
  assert.equal(data.size,1); assert.deepEqual(await restoreLatestWorkspaceSnapshot(storage,"verified-owner"), draft);
  await saveLatestWorkspaceSnapshot(storage,"verified-owner",{ ...draft, parsed: null });
  assert.deepEqual(await restoreLatestWorkspaceSnapshot(storage,"verified-owner"),draft);
  const before = storage.getItem("sokupa:latest-result:v1:verified-owner");
  const broken = { ...storage, setItem: () => { throw new Error("quota"); } };
  await assert.rejects(saveLatestWorkspaceSnapshot(broken,"verified-owner",{ ...draft, siteName: "unsaved" }));
  assert.equal(storage.getItem("sokupa:latest-result:v1:verified-owner"), before);
});
test("explicit replacement adds no history keys, and a foreign-tab update blocks overwrite", () => {
  const data = new Map<string,string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, raw: string) => { data.set(key,raw); } };
  const draft: WorkspaceDraft = { version: 1, siteName: "Latest", parsed: { items: [item] }, orderDraftItems: [] };
  const first = replaceWorkspaceDraft(storage,"workspace",null,draft); replaceWorkspaceDraft(storage,"workspace",first.raw,{ ...draft, siteName: "Replacement" });
  assert.equal(data.size,1); assert.throws(() => replaceWorkspaceDraft(storage,"workspace",first.raw,draft));
});

test("explicit snapshot repair preserves corrupt bytes and never overwrites a different quarantine", async () => {
  const data = new Map<string,string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, raw: string) => { data.set(key,raw); }, removeItem: (key: string) => { data.delete(key); } };
  const draft: WorkspaceDraft = { version:1,siteName:"valid primary",parsed:{items:[item]},originalParsed:{items:[item]},orderDraftItems:[] };
  const key="sokupa:latest-result:v1:owner"; storage.setItem(key,"broken-first");
  await assert.rejects(restoreLatestWorkspaceSnapshot(storage,"owner"));
  await rebuildLatestWorkspaceSnapshot(storage,"owner",draft);
  assert.deepEqual(await restoreLatestWorkspaceSnapshot(storage,"owner"),{...draft,resultJobId:null});
  assert.equal(storage.getItem(`${key}:unreadable`),"broken-first"); assert.equal(data.size,2);
  storage.setItem(key,"broken-second"); await assert.rejects(rebuildLatestWorkspaceSnapshot(storage,"owner",draft));
  assert.equal(storage.getItem(key),"broken-second"); assert.equal(storage.getItem(`${key}:unreadable`),"broken-first");
});
