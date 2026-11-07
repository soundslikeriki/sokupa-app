import type { MemoReadingReview } from "../types";

/** Presentation only: the original review evidence and confirmation fingerprint stay untouched. */
export function compactReadingReviews(reviews: MemoReadingReview[]): MemoReadingReview[] {
  const grouped = new Map<string, MemoReadingReview>();
  for (const review of reviews) {
    const previous = grouped.get(review.reason);
    grouped.set(review.reason, { ...review, candidate_formulas: [...new Set([...(previous?.candidate_formulas ?? []), ...review.candidate_formulas])] });
  }
  return [...grouped.values()];
}

export function compactReviewReasons(items: { product_code: string; review_reasons?: string[] }[]) {
  const grouped = new Map<string, Set<string>>();
  for (const item of items) for (const reason of item.review_reasons ?? []) {
    const codes = grouped.get(reason) ?? new Set<string>(); codes.add(item.product_code); grouped.set(reason, codes);
  }
  return [...grouped].map(([reason, codes]) => ({ reason, codes: [...codes] }));
}

export function shortOrderStatus(item: { orderReady: boolean; readingReviews: unknown[]; readingReviewConfirmed: boolean;
  incompleteMeasurements: boolean; incompleteSettings: boolean; order_quantity_input?: string;
  order_mode?: string; pattern_match?: string; canConfirm: boolean; quantityAssessment: { shortage?: string | null } }) {
  if (item.incompleteMeasurements || item.incompleteSettings || item.order_quantity_input !== undefined) return "入力未完了";
  if (item.readingReviews.length && !item.readingReviewConfirmed) return "訂正・取消を確認";
  if (item.order_mode === "pattern" && !item.canConfirm) return item.pattern_match === "other" ? "職人さんに確認" : "リピート条件を確認";
  if (item.quantityAssessment.shortage && item.quantityAssessment.shortage !== "0") return "必要量に不足";
  return item.orderReady ? "確認済み" : "数量を確認";
}
