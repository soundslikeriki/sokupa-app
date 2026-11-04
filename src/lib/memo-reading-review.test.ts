import test from "node:test";
import assert from "node:assert/strict";
import { annotateVisionReadingReviews, candidateFormulasInNotes, normalizeReadingReviews, readingReviewsForItem } from "./memo-reading-review";
import { mergeParsedPayloads, requiresMemoReview, validateMemoEntry } from "./memo-calculation";
import type { MemoProductItem } from "../types";

test("a confident exclusion note retains the corrected-row candidate even without model review flags", () => {
  const raw = { product_code: "ANON-A", needs_review: false, correction_needs_review: false, confidence: 1,
    notes: "1.00 x 12 は取り消し線があるため除外しました。", entries: [{ original_formula: "1.20×8" }, { original_formula: "2.70×6" }] };
  const [item] = annotateVisionReadingReviews([raw]);
  const reviews = normalizeReadingReviews(item.vision_reading_reviews);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].candidate_formulas, ["1.00 x 12"]);
  assert.equal(raw.entries.length, 2, "never silently add or remove a candidate");
  const base: MemoProductItem = { product_code: "ANON-A", manufacturer: "Synthetic", entries: raw.entries.map(validateMemoEntry), notes: raw.notes,
    total_m: 25.8, order_quantity: 30, reading_reviews: reviews };
  assert.equal(requiresMemoReview({ items: [base] }), true);
  const omitted = mergeParsedPayloads([{ items: [base] }]);
  assert.equal(omitted.items[0].total_m, 25.8);
  assert.equal(omitted.items[0].needs_review, true);
  // User says this was a corrected, valid row. The anonymized expected result includes it.
  const corrected = mergeParsedPayloads([{ items: [{ ...base, entries: [...base.entries, validateMemoEntry({ original_formula: "1.00×12" })] }] }]);
  assert.equal(corrected.items[0].total_m, 37.8);
  assert.equal(corrected.items[0].order_quantity, 44);
  assert.deepEqual(corrected.items[0].reading_reviews?.[0].candidate_formulas, ["1.00 x 12"]);
});

test("structured correction candidates preserve raw alternatives without trusting an AI confirmation", () => {
  const [item] = annotateVisionReadingReviews([{ correction_needs_review: true, correction_candidates: [{ original_formula: "2.00×3", reason: "訂正値の候補" }, { formula: "2.50×3" }], reading_review_confirmation: "model-claimed-confirmed" }]);
  const reviews = normalizeReadingReviews(item.vision_reading_reviews);
  assert.deepEqual(reviews[0].candidate_formulas, ["2.00×3", "2.50×3"]);
  assert.match(reviews[0].reason, /訂正値の候補/);
  assert.deepEqual(candidateFormulasInNotes("訂正候補 2.00 m × (3+2)、旧2-50×3"), ["2.00 m × (3+2)", "2-50×3"]);
});

test("global exclusions survive unrelated local notes instead of inferring a product scope", () => {
  const items = [{ product_code: "ANON-A" }, { product_code: "ANON-B" }];
  const global = annotateVisionReadingReviews(items, "取り消し線の行を除外しました。");
  assert.ok(global.every(item => normalizeReadingReviews(item.vision_reading_reviews).length === 1));
  const scoped = annotateVisionReadingReviews([{ ...items[0], notes: "品番を書き直しました。" }, items[1]], "取り消し線の行を除外しました。");
  assert.equal(normalizeReadingReviews(scoped[0].vision_reading_reviews).length, 2);
  assert.equal(normalizeReadingReviews(scoped[1].vision_reading_reviews).length, 1);
  const distinct = annotateVisionReadingReviews([{ ...items[0], notes: "品番を書き直しました。" }, items[1]], "ANON-Bの3×4行を取消として除外しました。");
  const second = normalizeReadingReviews(distinct[1].vision_reading_reviews);
  assert.deepEqual(second[0].candidate_formulas, ["3×4"]);
  assert.match(second[0].reason, /ANON-B/);
  assert.deepEqual(annotateVisionReadingReviews(items, "幅数の加算を先に計算しました。").map(item => item.vision_reading_reviews), [[], []]);
});

test("old top-level notes participate in review and merging even if products have no warning metadata", () => {
  const base: MemoProductItem = { product_code: "ANON-B", manufacturer: "Synthetic", entries: [validateMemoEntry({ original_formula: "2×1" })], total_m: 2, order_quantity: 3 };
  const notes = "3×4の行を取消として除外しました。";
  assert.deepEqual(readingReviewsForItem(base, notes)[0].candidate_formulas, ["3×4"]);
  assert.equal(requiresMemoReview({ items: [base], notes }), true);
  const merged = mergeParsedPayloads([{ items: [base], notes }]);
  assert.equal(merged.items[0].needs_review, true);
  assert.deepEqual(merged.items[0].reading_reviews?.[0].candidate_formulas, ["3×4"]);
  assert.equal(merged.items[0].total_m, 2);
  const reviews = readingReviewsForItem(base, notes);
  assert.deepEqual(readingReviewsForItem({ ...base, reading_reviews: reviews }, notes), reviews, "global notes must not grow on repeated restoration");
});

test("legacy notes and repeated canonicalization remain under review without growing warnings", () => {
  const item = { notes: "Corrected 1.20×3; crossed out original value." };
  const first = readingReviewsForItem(item);
  for (let index = 0; index < 5; index++) assert.deepEqual(readingReviewsForItem({ ...item, reading_reviews: first }), first);
  assert.deepEqual(normalizeReadingReviews([...first, ...first]), first);
  assert.equal(readingReviewsForItem({ notes: "数量加算を検算しました。" }).length, 0);
});

test("multiple images retain candidates and their source without leaking a previous confirmation", () => {
  const item = (note: string): MemoProductItem => ({ product_code: "ANON-A", manufacturer: "Synthetic", notes: note, reading_review_confirmation: "old-client-confirmation",
    entries: [validateMemoEntry({ original_formula: "2.00×1" })], total_m: 2, order_quantity: 3 });
  const merged = mergeParsedPayloads([{ items: [item("訂正候補 1.20×3")] }, { items: [item("取消候補 2.50×4")] }]);
  assert.equal(merged.items[0].total_m, 4);
  assert.equal(merged.items[0].reading_reviews?.length, 2);
  assert.deepEqual(merged.items[0].reading_reviews?.map(review => review.source_image_index), [0, 1]);
  assert.equal(merged.items[0].reading_review_confirmation, undefined);
  assert.equal(requiresMemoReview(merged), true);
  assert.equal(merged.items[0].entries.length, 2);
});

test("review metadata is bounded, copied, and never interprets candidate strings as code", () => {
  const reviews = normalizeReadingReviews([null, { reason: "" }, { reason: "訂正あり", candidate_formulas: [null, "process.exit()", "2×3", "2×3"], source_image_index: -1 }, { reason: "取消あり", candidate_formulas: [], source_image_index: 1 }]);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[0].candidate_formulas, ["process.exit()", "2×3"]);
  assert.equal(reviews[0].source_image_index, undefined);
  assert.equal(reviews[1].source_image_index, 1);
});
