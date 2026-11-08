import test from "node:test";
import assert from "node:assert/strict";
import type { MemoProductItem } from "../types";
import { identifyMaterials, materialSignature, originalMaterial, validMaterialId } from "./material-identity";
import { readWorkspaceDraft } from "./workspace-draft";
const make = (source?: string, quantity = 23): MemoProductItem => ({ product_code: "DUP", manufacturer: "Synthetic",
  entries: [{ original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4, ...(source ? { source_row_id: source } : {}) }], total_m: 5.4, order_quantity: quantity, manual_order_quantity: quantity });
const raw = (item: MemoProductItem) => { const copy = { ...item }; delete copy.client_material_id; return copy; };
const fresh = () => { let n = 0; return () => `material-v1-fresh-${++n}`; };
test("material IDs are persisted birth identities, independent of SKU, order and numeric edits", () => {
  const first = identifyMaterials([], [make("row-a", 51), make("row-b")], "job-a");
  assert.ok(first.every(item => validMaterialId(item.client_material_id)));
  assert.notEqual(first[0].client_material_id, first[1].client_material_id);
  const edited = [{ ...first[0], product_code: "EDIT", order_quantity: 61 }, first[1]];
  const reordered = identifyMaterials(first, edited.toReversed(), "job-a");
  assert.deepEqual(reordered.map(item => item.client_material_id), first.map(item => item.client_material_id).toReversed());
  assert.equal(reordered[1].order_quantity, 61);
  assert.deepEqual(identifyMaterials([], [make("row-a", 51), make("row-b")], "job-a"), first, "two initial tabs assign identical IDs");
  assert.notEqual(identifyMaterials([], [make("row-a",51), make("row-b")], "job-b")[0].client_material_id, first[0].client_material_id);
});
test("legacy snapshots follow only unique immutable row references, not code or dimensions", () => {
  const first = identifyMaterials([], [make("row-a", 51), make("row-b")], "job");
  const next = identifyMaterials(first, first.toReversed().map(raw), "job");
  assert.equal(next[0].client_material_id, first[1].client_material_id);
  assert.equal(next[1].client_material_id, first[0].client_material_id);
  const anonymous = identifyMaterials([], [make(), make()], "job");
  const ambiguous = identifyMaterials(anonymous, anonymous.toReversed().map(raw), "job", fresh());
  assert.ok(ambiguous.every(item => !anonymous.some(old => old.client_material_id === item.client_material_id)));
  assert.equal(new Set(ambiguous.map(item => item.client_material_id)).size, 2);
});
test("prepend/delete preserve remaining materials and cloned duplicate IDs cannot share edits", () => {
  const first = identifyMaterials([], [make("row-a",51),make("row-b")], "job");
  const next = identifyMaterials(first, [make("new",7),...first], "job",fresh());
  assert.equal(next[1].client_material_id, first[0].client_material_id);
  assert.equal(next[2].client_material_id, first[1].client_material_id);
  assert.equal(identifyMaterials(next,next.slice(1),"job")[0].client_material_id,first[0].client_material_id);
  const duplicate = identifyMaterials(first,[first[0],structuredClone(first[0])],"job",fresh());
  assert.equal(new Set(duplicate.map(item=>item.client_material_id)).size,2);
  assert.ok(duplicate.every(item=>item.client_material_id!==first[0].client_material_id));
});
test("contradictory source references and ambiguous merged source anchors never borrow old identity", () => {
  const first=identifyMaterials([],[make("a"),make("b")],"job");
  assert.notEqual(identifyMaterials(first,[{...make("b"),client_material_id:first[0].client_material_id}],"job",fresh())[0].client_material_id,first[0].client_material_id);
  const merged={...make(),entries:[...first[0].entries,...first[1].entries]};
  const result=identifyMaterials(first,[merged],"job",fresh());
  assert.ok(!first.some(item=>item.client_material_id===result[0].client_material_id));
});
test("image/entry anchors support legacy originals; ambiguous originals refuse reset",()=>{
  const first=make();first.entries[0].source_image_index=0;first.entries[0].source_entry_index=0;
  const second=make();second.entries[0].source_image_index=1;second.entries[0].source_entry_index=0;
  const identified=identifyMaterials([],[first,second],"job");
  const next=identifyMaterials(identified,[second,first],"job");
  assert.equal(next[0].client_material_id,identified[1].client_material_id);
  assert.equal(originalMaterial({...next[0],product_code:"EDIT"},[first,second]),second);
  assert.equal(originalMaterial({...make(),order_quantity:61},[make(),make()]),undefined);
  assert.equal(originalMaterial(make("other-source"),[make("original-source")],true),undefined,"same SKU never overrides contradictory source references");
});
test("local IDs round-trip through legacy-compatible workspace and do not change material content signature",()=>{
  const old=make("a"),identified=identifyMaterials([],[old],"job")[0];
  assert.equal(materialSignature(old),materialSignature(identified));
  const draft={version:1,siteName:"Next site",parsed:{items:[identified]},orderDraftItems:[]};
  assert.equal(readWorkspaceDraft(JSON.stringify(draft)).parsed!.items[0].client_material_id,identified.client_material_id);
  assert.equal(readWorkspaceDraft(JSON.stringify({...draft,parsed:{items:[old]}})).parsed!.items[0].client_material_id,undefined);
  assert.throws(()=>readWorkspaceDraft(JSON.stringify({...draft,parsed:{items:[{...old,client_material_id:"bad"}]}})));
});
