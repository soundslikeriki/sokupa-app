import test from "node:test";
import assert from "node:assert/strict";
import { inspectCopyReview, prepareCopyReviewConfirmation, type CopyReviewInput } from "./copy-review";
import { planMemoOrder } from "./order-planning";

const input: CopyReviewInput = { item: { product_code: "SYN-A", manufacturer: "Synthetic", total_m: 20, order_quantity: 23,
  entries: [{ source_row_id: "row-a", source_image_index: 1, source_entry_index: 0, original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }],
  reading_reviews: [{ reason: "訂正候補を照合", candidate_formulas: ["1×2"], source_image_index: 1 }] },
  rows: [{ id: "row-a", length: 20, quantity: 1, active: false }], repeatCm: null, basis: "unconfirmed", match: "unconfirmed", lossRate: 15 };
const context = { sourceJobId: "job-a", siteName: "Synthetic", itemKey: "0:SYN-A" };
const apply = (value: CopyReviewInput, ack: NonNullable<ReturnType<typeof prepareCopyReviewConfirmation>>) => planMemoOrder({ ...value,
  readingReviewConfirmation: ack.readingReviewConfirmation, confirmation: ack.quantityConfirmation });

test("optional reading review records only evidence without manufacturing a quantity acknowledgement", () => {
  const review = inspectCopyReview(input, context);
  const naive = planMemoOrder({ ...input, readingReviewConfirmation: review.plan.readingReviewFingerprint, confirmation: review.plan.fingerprint });
  assert.equal(naive.ready, true, "valid output does not depend on recording a source review");
  const ack = prepareCopyReviewConfirmation(input, context, review.token)!;
  assert.ok(ack); assert.equal(ack.quantityConfirmation, "");
  assert.equal(apply(input, ack).ready, true);
  assert.equal(apply(input, ack).totalM, 20, "candidates are not added automatically");
  const legacy = { ...input, confirmation: "old-quantity-flag" };
  assert.equal(prepareCopyReviewConfirmation(legacy, context, inspectCopyReview(legacy, context).token)!.quantityConfirmation, "old-quantity-flag", "legacy flags are carried unchanged, never converted into a new confirmation");
});

test("existing valid source and quantity confirmations remain valid and do not alter content identity", () => {
  const review = inspectCopyReview(input, context), ack = prepareCopyReviewConfirmation(input, context, review.token)!;
  const confirmed = { ...input, readingReviewConfirmation: ack.readingReviewConfirmation, confirmation: ack.quantityConfirmation };
  const next = inspectCopyReview(confirmed, context);
  assert.equal(next.plan.ready, true); assert.equal(next.token, review.token);
  assert.deepEqual(prepareCopyReviewConfirmation(confirmed, context, next.token), ack);
});

test("invalid output and unfinished calculation conditions cannot create an optional source acknowledgement", () => {
  const pattern = { ...input, item: { ...input.item, order_mode: "pattern" as const }, rows: [{ ...input.rows[0], active: true }], repeatCm: 60 };
  const variants: CopyReviewInput[] = [
    { ...input, manualQuantity: -1 }, { ...input, rawOrder: "" }, { ...input, rows: [{ ...input.rows[0], lengthInput: "" }] },
    { ...input, rows: [{ ...input.rows[0], quantityInput: "-1" }] },
    { ...input, item: { ...input.item, loss_rate_input: "-1" } }, pattern,
    { ...pattern, basis: "trim-included", match: "other" }, { ...pattern, basis: "repeat-adjusted", match: "straight" },
    { ...pattern, item: { ...pattern.item, repeat_height_input: "-1" }, basis: "trim-included", match: "straight" },
  ];
  for (const value of variants) {
    const review = inspectCopyReview(value, context);
    assert.equal(review.confirmable, false);
    assert.equal(prepareCopyReviewConfirmation(value, context, review.token), null);
  }
});

test("stale intent is rejected after any candidate, code, source reference, quantity or context change", () => {
  const token = inspectCopyReview(input, context).token;
  const variants: CopyReviewInput[] = [
    { ...input, item: { ...input.item, product_code: "SYN-B" } },
    { ...input, item: { ...input.item, manufacturer: "Changed" } },
    { ...input, item: { ...input.item, reading_reviews: [{ reason: "新しい訂正", candidate_formulas: ["3×4"], source_image_index: 0 }] } },
    { ...input, item: { ...input.item, entries: [{ ...input.item.entries[0], source_image_index: 0 }] } },
    { ...input, item: { ...input.item, entries: [{ ...input.item.entries[0], original_formula: "訂正20×1" }] } },
    { ...input, rows: [{ ...input.rows[0], quantity: 2 }] }, { ...input, lossRate: 18 }, { ...input, manualQuantity: 24 },
    { ...input, globalNotes: "別の取消候補 2×3" },
  ];
  for (const value of variants) assert.equal(prepareCopyReviewConfirmation(value, context, token), null);
  for (const change of [{ sourceJobId: "job-b" }, { siteName: "Changed" }, { itemKey: "1:SYN-A" }, { collectionKey: "SYN-A,SYN-B" }]) {
    assert.equal(prepareCopyReviewConfirmation(input, { ...context, ...change }, token), null);
  }
});

test("identical notes or photo numbers never authorize another product", () => {
  const a = { ...input, globalNotes: "別の行を取消として除外 3×4" };
  const b = { ...a, item: { ...input.item, product_code: "SYN-B", reading_reviews: [{ reason: "B固有の訂正", candidate_formulas: ["5×2"], source_image_index: 1 }] } };
  const first = inspectCopyReview(a, context), secondContext = { ...context, itemKey: "1:SYN-B" }, second = inspectCopyReview(b, secondContext);
  assert.equal(first.plan.readingReviews.length, 2); assert.equal(second.plan.readingReviews.length, 2);
  assert.notEqual(first.token, second.token);
  assert.equal(prepareCopyReviewConfirmation(b, secondContext, first.token), null);
  assert.deepEqual(second.plan.readingReviews[0].candidate_formulas, ["5×2"]);
});

test("manual and already-adjusted final quantities keep the original calculation semantics", () => {
  for (const value of [{ ...input, manualQuantity: 27 }, { ...input, item: { ...input.item, memo_allowance: "included" as const } }]) {
    const review = inspectCopyReview(value, context), ack = prepareCopyReviewConfirmation(value, context, review.token)!;
    const confirmed = apply(value, ack);
    assert.equal(confirmed.ready, true); assert.equal(confirmed.orderQuantity, value.manualQuantity ?? 20);
  }
});
