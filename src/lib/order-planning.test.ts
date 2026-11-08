import test from "node:test";
import assert from "node:assert/strict";
import { orderModeForItem, planMemoOrder } from "./order-planning";
import { readWorkspaceDraft } from "./workspace-draft";
import { dimensionItemToOrderDraftInput } from "./order-draft";
import { buildOrderRequestText } from "./order-text";
import type { MemoProductItem } from "../types";

const item: MemoProductItem = { product_code: "SYNTHETIC", manufacturer: "Synthetic", entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }], total_m: 20, order_quantity: 23 };
const input = { item, rows: [{ id: "a", length: 20, quantity: 1, active: false }], repeatCm: null, basis: "unconfirmed", match: "unconfirmed", lossRate: 15 };
const confirm = (value: Parameters<typeof planMemoOrder>[0]) => planMemoOrder({ ...value, confirmation: planMemoOrder(value).fingerprint });

test("simple memo mode keeps 20m + 15% = 23m without requiring a quantity acknowledgement", () => {
  const plan = planMemoOrder(input);
  assert.equal(plan.mode, "memo"); assert.equal(plan.totalM, 20); assert.equal(plan.orderQuantity, 23);
  assert.equal(plan.canConfirm, true); assert.equal(plan.ready, true); assert.equal(plan.confirmed, false);
  assert.match(plan.assessment.message, /入力値上は必要量以上/);
  assert.equal(confirm(input).ready, true);
  assert.equal(planMemoOrder({ ...input, rows: [{ ...input.rows[0], length: 20.000001 }] }).orderQuantity, 23, "retain the existing four-decimal subtotal rounding before reserve calculation");
});

test("already-final memo quantities skip repeat and reserve without changing the default reserve", () => {
  const final = { ...input, item: { ...item, order_mode: "memo" as const, memo_allowance: "included" as const }, rows: [{ ...input.rows[0], active: true }], repeatCm: 60 };
  const plan = confirm(final);
  assert.equal(plan.totalM, 20); assert.equal(plan.orderQuantity, 20); assert.equal(plan.ready, true);
  assert.equal(final.lossRate, 15); assert.equal(final.rows[0].active, true);
  assert.equal(plan.comparison.strict.rows[0].selectedMode, "original");
  const patterned = planMemoOrder({ ...final, item: { ...final.item, order_mode: "pattern" }, basis: "trim-included", match: "straight" });
  assert.equal(patterned.totalM, 20.4); assert.equal(patterned.orderQuantity, 24); assert.equal(patterned.allowanceIncluded, false);
});

test("restored legacy active-repeat drafts keep distinct heights and the saved manual final amount", () => {
  const legacy: MemoProductItem = { ...item, entries: [{ ...item.entries[0], length_m: 2.7, quantity: 2, repeat_enabled: true }, { ...item.entries[0], length_m: 3.8, quantity: 1, repeat_enabled: true }], manual_order_quantity: 15 };
  assert.equal(orderModeForItem(legacy), "pattern");
  const plan = confirm({ ...input, item: legacy, rows: [{ id: "a", length: 2.7, quantity: 2, active: true }, { id: "b", length: 3.8, quantity: 1, active: true }], repeatCm: 60, basis: "trim-included", match: "straight", manualQuantity: legacy.manual_order_quantity });
  assert.equal(plan.totalM, 10.2); assert.equal(plan.automaticQuantity, 12); assert.equal(plan.orderQuantity, 15); assert.equal(plan.ready, true);
  assert.deepEqual(plan.comparison.strict.rows.map(row => row.selected.perStripM), ["3", "4.2"]);
  const simple = confirm({ ...input, item: { ...legacy, order_mode: "memo" }, manualQuantity: 15 });
  assert.equal(simple.orderQuantity, 15); assert.equal(simple.ready, true); assert.equal(simple.assessment.status, "shortfall"); // Chosen quantity remains exportable with its shortage warning.
});

test("unknown and unsupported premises remain non-confident arithmetic without forbidding a valid chosen order", () => {
  const pattern = { ...input, item: { ...item, order_mode: "pattern" as const }, rows: [{ ...input.rows[0], active: true }], repeatCm: 60 };
  for (const overrides of [{}, { basis: "trim-included", match: "other" }, { basis: "repeat-adjusted", match: "straight" }, { basis: "trim-included", match: "straight", repeatCm: null }]) {
    const plan = confirm({ ...pattern, ...overrides });
    assert.equal(plan.canConfirm, false); assert.equal(plan.ready, true); assert.equal(plan.assessment.showCheckmark, false);
  }
  assert.match(planMemoOrder({ ...pattern, basis: "trim-included", match: "other" }).assessment.message, /職人さんに確認/);
  assert.equal(confirm({ ...pattern, basis: "trim-included", match: "straight" }).ready, true);
});

test("measurement defects do not block a chosen23m, but incomplete final order values do", () => {
  for (const overrides of [{ rows: [{ ...input.rows[0], lengthInput: "" }] }, { rows: [{ ...input.rows[0], quantityInput: "-1" }] }, { item: { ...item, loss_rate_input: "" } }]) {
    const plan = planMemoOrder({ ...input, ...overrides, manualQuantity: 23 });
    assert.equal(plan.orderQuantity, 23); assert.equal(plan.ready, true); assert.equal(plan.canConfirm, false);
    assert.equal(plan.assessment.showCheckmark, false);
  }
  for (const overrides of [{ rawOrder: "" }, { rawOrder: "-1" }, { manualQuantity: NaN }, { manualQuantity: Infinity }, { manualQuantity: -1 }, { item: { ...item, product_code: "" } }]) {
    assert.equal(planMemoOrder({ ...input, ...overrides }).ready, false);
  }
  const zero = planMemoOrder({ ...input, manualQuantity: 0 });
  assert.equal(zero.orderQuantity, 0); assert.equal(zero.ready, false); assert.equal(zero.assessment.status, "shortfall");
});

test("legacy quantity fingerprints are retained as history, not a gate on valid recalculated quantities", () => {
  const confirmation = planMemoOrder(input).fingerprint;
  assert.equal(planMemoOrder({ ...input, confirmation }).ready, true);
  const variants = [
    { manualQuantity: 24 }, { lossRate: 16 },
    { item: { ...item, memo_allowance: "included" as const } }, { rows: [{ ...input.rows[0], length: 21 }] },
    { item: { ...item, needs_review: true } }, { item: { ...item, product_code: "CHANGED" } },
  ];
  for (const overrides of variants) {
    const result = planMemoOrder({ ...input, ...overrides, confirmation });
    assert.equal(result.confirmed, false); assert.equal(result.ready, true);
  }
  assert.equal(planMemoOrder({ ...input, item: { ...item, order_mode: "pattern" }, confirmation }).ready, true, "unknown pattern premises warn without blocking a valid quantity");
  for (const legacyFlag of [undefined, "", "stale", confirmation]) assert.equal(planMemoOrder({ ...input, confirmation: legacyFlag }).ready, true);
});

test("draft roundtrip preserves the mode, latent repeat settings, raw inputs and final manual edits", () => {
  const saved: MemoProductItem = { ...item, order_mode: "memo", pattern_rows_configured: true, memo_allowance: "included", manual_order_quantity: 27, quantity_confirmation: "reviewed", loss_rate_percent: 15, loss_rate_input: "", repeat_cm: 60, repeat_cm_input: "-1", repeat_height_input: "-2", entries: [{ ...item.entries[0], repeat_enabled: true, quantity_input: "-1" }] };
  const draft = { version: 1, siteName: "Synthetic", parsed: { items: [saved] }, orderDraftItems: [] };
  assert.deepEqual(readWorkspaceDraft(JSON.stringify(draft)).parsed!.items[0], saved);
  for (const field of ["order_mode", "memo_allowance"]) assert.throws(() => readWorkspaceDraft(JSON.stringify({ ...draft, parsed: { items: [{ ...saved, [field]: "invalid" }] } })));
});

test("order text and draft transfer use the reviewed final quantity without a second adjustment", () => {
  const plan = confirm({ ...input, manualQuantity: 27 }); assert.equal(plan.ready, true);
  const final = { ...item, order_quantity: plan.orderQuantity, manual_order_quantity: 27 };
  assert.equal(dimensionItemToOrderDraftInput(final).quantity, 27);
  assert.match(buildOrderRequestText([final], "Synthetic"), /数量：27m/);
  assert.equal(confirm({ ...input, item: { ...item, memo_allowance: "included" } }).orderQuantity, 20);
});

const readingInput = { ...input, item: { ...item, reading_reviews: [{ reason: "訂正された候補式を計算から除外したため、原画像で確認してください。", candidate_formulas: ["1.5×4"], source_image_index: 1 }] } };
const reviewReading = (value: Parameters<typeof planMemoOrder>[0]) => ({ ...value, readingReviewConfirmation: planMemoOrder(value).readingReviewFingerprint });

test("exporting valid quantities never sets a separate correction review in either mode", () => {
  for (const value of [readingInput, { ...readingInput, item: { ...readingInput.item, order_mode: "pattern" as const }, basis: "trim-included", match: "straight", repeatCm: 60, rows: [{ ...input.rows[0], active: true }] }]) {
    const pending = confirm(value);
    assert.equal(pending.canConfirm, false); assert.equal(pending.ready, true); assert.equal(pending.readingReviewConfirmed, false);
    assert.match(pending.assessment.message, /訂正・取消/);
    const reviewed = planMemoOrder(reviewReading(value));
    assert.equal(reviewed.readingReviewConfirmed, true); assert.equal(reviewed.canConfirm, true); assert.equal(reviewed.ready, true); assert.equal(reviewed.confirmed, false);
    assert.equal(confirm(reviewReading(value)).ready, true);
    assert.equal(planMemoOrder({ ...reviewReading(value), readingReviewConfirmation: "" }).readingReviewConfirmed, false);
  }
  assert.equal(planMemoOrder(readingInput).totalM, 20, "a candidate is evidence, never an automatic added quantity");
  const legacy = planMemoOrder({ ...input, item: { ...item, needs_review: false, notes: "訂正候補 1.5×4 は読み取りから除外しました。" } });
  assert.equal(legacy.readingReviews.length, 1); assert.equal(legacy.canConfirm, false);
});

test("candidate review and general acknowledgement restore together and invalidate on later edits", () => {
  const reviewed = reviewReading(readingInput), final = confirm(reviewed);
  const savedItem = { ...readingInput.item, reading_review_confirmation: final.readingReviewFingerprint, quantity_confirmation: final.fingerprint };
  assert.equal(planMemoOrder({ ...readingInput, item: savedItem, confirmation: savedItem.quantity_confirmation }).ready, true);
  const variants = [
    { rows: [{ ...input.rows[0], quantity: 2 }] }, { manualQuantity: 25 }, { lossRate: 16 },
    { item: { ...readingInput.item, product_code: "CHANGED" } },
    { item: { ...readingInput.item, reading_reviews: [{ ...readingInput.item.reading_reviews[0], candidate_formulas: ["1.6×4"] }] } },
  ];
  for (const overrides of variants) {
    const changed = planMemoOrder({ ...readingInput, ...overrides, confirmation: final.fingerprint, readingReviewConfirmation: final.readingReviewFingerprint });
    assert.equal(changed.readingReviewConfirmed, false); assert.equal(changed.ready, true);
  }
  assert.equal(planMemoOrder({ ...reviewed, rows: [{ ...input.rows[0], quantityInput: "" }], confirmation: final.fingerprint }).canConfirmReadingReview, false);
});

test("a manually included corrected row is counted once and its candidate evidence remains", () => {
  const corrected = { ...readingInput, item: { ...readingInput.item, entries: [...item.entries, { original_formula: "1.5×4", length_m: 1.5, quantity: 4, subtotal_m: 6 }] }, rows: [...input.rows, { id: "b", length: 1.5, quantity: 4, active: false }] };
  const final = confirm(reviewReading(corrected));
  assert.equal(final.totalM, 26); assert.equal(final.orderQuantity, 30); assert.equal(final.ready, true);
  assert.deepEqual(final.readingReviews[0].candidate_formulas, ["1.5×4"]);
  assert.equal(dimensionItemToOrderDraftInput({ ...corrected.item, order_quantity: final.orderQuantity }).quantity, 30);
});

test("workspace validation preserves correction evidence and rejects malformed review arrays or image indexes", () => {
  const saved = { ...readingInput.item, reading_review_confirmation: "source-review-fingerprint" };
  const draft = { version: 1, siteName: "Synthetic", parsed: { items: [saved] }, originalParsed: { items: [readingInput.item] }, orderDraftItems: [] };
  assert.deepEqual(readWorkspaceDraft(JSON.stringify(draft)).parsed!.items[0], saved);
  const malformed = [null, {}, [{ reason: 1, candidate_formulas: [] }], [{ reason: "reason", candidate_formulas: {} }], [{ reason: "reason", candidate_formulas: [1] }],
    ...[-1, 0.1, 16, Number.MAX_SAFE_INTEGER + 1].map(source_image_index => [{ reason: "reason", candidate_formulas: [], source_image_index }])];
  for (const reading_reviews of malformed) assert.throws(() => readWorkspaceDraft(JSON.stringify({ ...draft, parsed: { items: [{ ...saved, reading_reviews }] } })));
  assert.throws(() => readWorkspaceDraft(JSON.stringify({ ...draft, parsed: { items: [{ ...saved, reading_review_confirmation: 1 }] } })));
});

test("global correction notes gate legacy restored items and cannot be hidden by another item's local warning", () => {
  const globalNotes = "別の材料の3×4行は取消として除外しました。原画像を照合してください。";
  const first = planMemoOrder({ ...input, item: { ...item, notes: "品番を書き直したため、原画像で確認してください。" }, globalNotes });
  const second = planMemoOrder({ ...input, item: { ...item, product_code: "SECOND", needs_review: false }, globalNotes });
  assert.ok(first.readingReviews.some(review => review.reason.includes("品番を書き直した")));
  for (const plan of [first, second]) {
    assert.ok(plan.readingReviews.some(review => review.candidate_formulas.includes("3×4")));
    assert.equal(plan.canConfirm, false); assert.equal(plan.ready, true);
  }
  const draft = { version: 1, siteName: "Synthetic", parsed: { items: [item], notes: globalNotes }, orderDraftItems: [] };
  const restored = readWorkspaceDraft(JSON.stringify(draft));
  const legacy = planMemoOrder({ ...input, item: restored.parsed!.items[0], globalNotes: restored.parsed!.notes });
  assert.equal(legacy.canConfirm, false); assert.ok(legacy.readingReviews.length > 0);
  const changed = planMemoOrder({ ...readingInput, globalNotes, readingReviewConfirmation: planMemoOrder(readingInput).readingReviewFingerprint });
  assert.equal(changed.readingReviewConfirmed, false, "new global evidence invalidates a previous per-item review");
});
