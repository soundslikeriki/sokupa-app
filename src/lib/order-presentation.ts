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

/** Show concrete reading risks, not generic catalog/calculation advice as repeated warnings. */
export function concreteReadingReason(reason: string): boolean {
  if (/^商品情報[：:]/u.test(reason) || reason === "画像：解析結果を原画像で確認してください") return false;
  return /訂正|取消|取り?消|除外|不鮮明|判読|読み取れ|読めな|解析でき|(?:画像|品番|式)[：:]/u.test(reason);
}

/** Display deduplication only. The exact affected product set remains explicit; no shared acknowledgement. */
export function readingEvidenceGroups(rows: { code: string; reviews: MemoReadingReview[] }[]) {
  const groups = new Map<string, { key: string; review: MemoReadingReview; codes: string[] }>();
  for (const row of rows) for (const review of normalizeDisplayReviews(row.reviews)) {
    const key = JSON.stringify(review), current = groups.get(key);
    if (current) { if (!current.codes.includes(row.code)) current.codes.push(row.code); }
    else groups.set(key, { key, review, codes: [row.code] });
  }
  return [...groups.values()];
}
const normalizeDisplayReviews = (reviews: MemoReadingReview[]) => reviews.map(review => ({ ...review, candidate_formulas: [...review.candidate_formulas] }));

export function compactReviewReasons(items: { product_code: string; review_reasons?: string[] }[]) {
  const grouped = new Map<string, Set<string>>();
  for (const item of items) for (const reason of item.review_reasons ?? []) {
    if (!concreteReadingReason(reason)) continue;
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
