import { calculateMultiHeightRepeat } from "./calculation/multi-height-repeat.mjs";
import { assessOrderQuantity } from "./calculation/order-quantity.mjs";
import type { MemoProductItem } from "../types";

export type ComparisonRow = { id: string; length: number; quantity: number; active: boolean; lengthInput?: string; quantityInput?: string };
export function compareProduct(item: MemoProductItem, rows: ComparisonRow[], repeatCm: number | null, basis: string, match: string) {
  const input: Parameters<typeof calculateMultiHeightRepeat>[0] = {
    productCode: item.product_code,
    repeat: { enabled: rows.some(row => row.active), matchType: match, ...(repeatCm !== null ? { vertical: { value: repeatCm, unit: "cm" as const } } : {}) },
    rows: rows.map(row => ({ id: row.id, sourceLength: { value: row.lengthInput ?? row.length, unit: "m" as const }, stripCount: row.quantityInput ?? row.quantity,
      lengthKind: basis === "trim-included" || basis === "repeat-adjusted" ? basis : "unknown" as const, applyRepeat: row.active })),
  };
  const strict = calculateMultiHeightRepeat(input);
  // Compare the selected input formula without claiming its construction premises
  // have been verified. Keep the strict assessment and stored flags independent.
  // Explicitly unsupported methods and already-adjusted active rows remain unknown.
  const inputArithmetic = calculateMultiHeightRepeat({ ...input,
    repeat: { ...input.repeat, matchType: match === "unconfirmed" ? "straight" : match },
    rows: input.rows.map(row => ({ ...row, lengthKind: basis === "unconfirmed" ? "trim-included" : row.lengthKind })),
  });
  const inputArithmeticNotice = rows.some(row => row.active) && (basis === "unconfirmed" || match === "unconfirmed")
    ? "入力した単純リピート式で比較しています。寸法区分・柄合わせ方式は未確認です。" : null;
  // A reference value is explicitly labelled until its premises are confirmed.
  // Already-adjusted rows are never rounded a second time, even for a reference.
  const reference = basis === "repeat-adjusted" || match === "other" ? null : calculateMultiHeightRepeat({ ...input, repeat: { ...input.repeat, matchType: "straight" }, rows: input.rows.map(row => ({ ...row, lengthKind: "trim-included" })) });
  const fingerprint = JSON.stringify({ code: item.product_code, manufacturer: item.manufacturer, spec: item.spec, repeatInfo: item.repeat_info, rows, repeatCm, basis, match,
    review: { product: item.needs_review, reasons: item.review_reasons, entries: item.entries.map(entry => ({ review: entry.needs_review, reason: entry.review_reason })) } });
  const premisesAvailable = basis === "trim-included" && (!rows.some(row => row.active) || match === "straight") && strict.status === "calculated";
  return { strict, reference, inputArithmetic, inputArithmeticNotice, hasActiveRepeat: rows.some(row => row.active), fingerprint, premisesAvailable };
}

export function assessProductOrder(ordered: unknown, required: string | null, confirmed: boolean) {
  return assessOrderQuantity({ orderedQuantity: ordered, requiredQuantity: required, orderedUnit: "m", requiredUnit: "m", assumptionsConfirmed: confirmed });
}
