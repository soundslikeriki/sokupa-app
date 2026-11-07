import { planMemoOrder } from "./order-planning";

export type CopyReviewInput = Parameters<typeof planMemoOrder>[0];
export type CopyReviewContext = { sourceJobId: string | null; siteName: string; itemKey: string; collectionKey?: string };

/** Content identity deliberately excludes acknowledgements, but includes every source reference. */
export function inspectCopyReview(input: CopyReviewInput, context: CopyReviewContext) {
  const plan = planMemoOrder(input);
  const token = JSON.stringify({ version: 1, context, comparison: plan.comparison.fingerprint,
    reading: plan.readingReviewFingerprint, reviews: plan.readingReviews, notes: input.globalNotes,
    sources: input.item.entries.map(entry => ({ formula: entry.original_formula, id: entry.source_row_id,
      image: entry.source_image_index, index: entry.source_entry_index })),
    mode: plan.mode, allowance: input.item.memo_allowance, quantity: plan.orderQuantity,
    manual: plan.manual, rawOrder: input.rawOrder, lossRate: input.lossRate,
    rawSettings: [input.item.loss_rate_input, input.item.repeat_cm_input, input.item.repeat_height_input] });
  // A combined explicit acknowledgement is planned in order: source review, then quantity.
  const readingConfirmation = plan.readingReviewConfirmed
    ? input.readingReviewConfirmation ?? input.item.reading_review_confirmation
    : plan.canConfirmReadingReview ? plan.readingReviewFingerprint : undefined;
  const reviewed = planMemoOrder({ ...input, readingReviewConfirmation: readingConfirmation });
  const proposed = planMemoOrder({ ...input, readingReviewConfirmation: readingConfirmation, confirmation: reviewed.fingerprint });
  const confirmable = reviewed.canConfirm && proposed.ready;
  return { token, plan, confirmable, blockedMessage: confirmable ? "" : proposed.assessment.message,
    acknowledgement: { readingReviewConfirmation: readingConfirmation, quantityConfirmation: reviewed.fingerprint } };
}

/** Never accept a checkbox for an earlier product/candidate/photo/quantity snapshot. */
export function prepareCopyReviewConfirmation(input: CopyReviewInput, context: CopyReviewContext, expectedToken: string) {
  const review = inspectCopyReview(input, context);
  return review.token === expectedToken && review.confirmable ? review.acknowledgement : null;
}
