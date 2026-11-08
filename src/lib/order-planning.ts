import { calculateOrderQuantity } from "./calc-logic";
import { roundMeters } from "./memo-calculation";
import { assessProductOrder, compareProduct, type ComparisonRow } from "./product-comparison";
import { readingReviewsForItem } from "./memo-reading-review";
import type { MemoProductItem } from "../types";
import { orderOutputIssue } from "./order-output";

export function orderModeForItem(item: MemoProductItem): "memo" | "pattern" {
  return item.order_mode ?? (item.entries.some(entry => entry.repeat_enabled) ? "pattern" : "memo");
}

/** Export the chosen quantity; arithmetic and source-review status never silently replace it. */
export function planMemoOrder(input: {
  item: MemoProductItem;
  rows: ComparisonRow[];
  repeatCm: number | null;
  basis: string;
  match: string;
  lossRate: number;
  manualQuantity?: number;
  rawOrder?: string;
  confirmation?: string;
  readingReviewConfirmation?: string;
  globalNotes?: unknown;
}) {
  const { item, repeatCm, basis, match, lossRate, manualQuantity, rawOrder, confirmation } = input;
  const mode = orderModeForItem(item);
  const allowanceIncluded = mode === "memo" && item.memo_allowance === "included";
  const rows = input.rows.map(row => ({ ...row, active: mode === "pattern" && row.active }));
  const comparison = compareProduct(item, rows, repeatCm, basis, match);
  // Only a displayed estimate can fall back to reference arithmetic. It cannot authorize output.
  const required = comparison.strict.totals.selectedM;
  const totalM = rows.reduce((sum, row, index) => {
    const exact = comparison.strict.rows[index]?.selected.perStripM ?? comparison.reference?.rows[index]?.selected.perStripM;
    const length = exact === null || exact === undefined ? row.length : Number(exact);
    return roundMeters(sum + roundMeters(length * row.quantity));
  }, 0);
  const automaticQuantity = calculateOrderQuantity(totalM, allowanceIncluded ? 0 : lossRate);
  const manual = typeof manualQuantity === "number" && Number.isFinite(manualQuantity);
  const orderQuantity = manual ? Math.max(0, Math.round(manualQuantity)) : automaticQuantity;
  const incompleteMeasurements = rows.some(row => row.lengthInput !== undefined || row.quantityInput !== undefined);
  const incompleteSettings = (!allowanceIncluded && item.loss_rate_input !== undefined) || (mode === "pattern" && (item.repeat_cm_input !== undefined || item.repeat_height_input !== undefined));
  const invalidInput = incompleteMeasurements || incompleteSettings || rawOrder !== undefined || comparison.strict.status === "invalid" || !Number.isFinite(orderQuantity) || orderQuantity < 0;
  const validNumbers = !invalidInput && comparison.strict.status === "calculated";
  const supported = mode === "memo" || (comparison.premisesAvailable && match !== "other");
  const readingReviews = readingReviewsForItem(item, input.globalNotes);
  const readingReviewFingerprint = readingReviews.length ? JSON.stringify({ version: 1,
    product: { code: item.product_code, manufacturer: item.manufacturer, spec: item.spec }, readingReviews,
    rows: input.rows, sourceRows: item.entries.map(entry => ({ formula: entry.original_formula, id: entry.source_row_id, image: entry.source_image_index, index: entry.source_entry_index })),
    mode, allowance: item.memo_allowance ?? "add", lossRate, orderQuantity, manual }) : "";
  const canConfirmReadingReview = !incompleteMeasurements && !incompleteSettings && rawOrder === undefined && comparison.strict.rows.length > 0 && comparison.strict.rows.every(row => row.original.status === "calculated");
  const readingReviewConfirmed = !readingReviews.length || (canConfirmReadingReview && (input.readingReviewConfirmation ?? item.reading_review_confirmation) === readingReviewFingerprint);
  const fingerprint = JSON.stringify({ version: 1, comparison: comparison.fingerprint, mode, allowance: item.memo_allowance ?? "add", lossRate, orderQuantity, manual,
    ...(readingReviews.length ? { readingReviewFingerprint, readingReviewConfirmed } : {}) });
  const canConfirm = validNumbers && supported && readingReviewConfirmed;
  // Retain the legacy fingerprint status for old saved data; it no longer gates output.
  const confirmed = canConfirm && confirmation === fingerprint;
  const assessment = assessProductOrder(rawOrder ?? orderQuantity, required, validNumbers && supported);
  const outputIssue = orderOutputIssue(item.product_code, manualQuantity !== undefined && (!Number.isFinite(manualQuantity) || manualQuantity < 0) ? manualQuantity : orderQuantity, rawOrder);
  const ready = outputIssue === null;
  let message = assessment.message;
  if (invalidInput) message = "要確認：長さ・幅数・予備分・発注数量の入力を完成させてください。";
  else if (!supported) message = match === "other"
    ? "職人さんに確認：半落ち・その他の柄合わせは自動計算できません。確認した発注量はメモの数量として入力してください。"
    : basis === "repeat-adjusted"
      ? "柄調整済みの数量は再計算しません。メモの数量を使い、予備分を確認してください。"
      : "職人さんに確認：切り代・柄合わせ方式・リピート値を確認してください。表示は参考値です。";
  else if (!readingReviewConfirmed) message = "要確認：訂正・取消の候補を原画像と照合し、有効な訂正値を明細に反映するか、取消として除外したことを確認してください。";
  else if (assessment.status === "sufficient") message = "入力値上は必要量以上です。";
  return { mode, allowanceIncluded, comparison, totalM, automaticQuantity, orderQuantity, manual, incompleteMeasurements, incompleteSettings,
    readingReviews, readingReviewFingerprint, readingReviewConfirmed, canConfirmReadingReview,
    canConfirm, confirmed, fingerprint, ready, outputIssue, assessment: { ...assessment, message } };
}
