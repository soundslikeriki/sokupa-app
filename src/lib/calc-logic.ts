import type { RepeatInfo } from "@/types";

/** API / 正規化で repeat_info をオブジェクトに揃える（レガシー文字列も許容） */
export function parseRepeatInfoRaw(raw: unknown): RepeatInfo | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? { from_product: t } : undefined;
  }
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const fp = typeof o.from_product === "string" ? o.from_product.trim() : "";
    return fp ? { from_product: fp } : undefined;
  }
  return undefined;
}

/**
 * API・初期 UI で用いるデフォルトのロス率（0〜1）。
 * 将来的にユーザー設定で上書きする前提の単一ソース。
 */
export const DEFAULT_LOSS_RATE = 0.15;

/** 表示用（整数パーセント） */
export const DEFAULT_LOSS_RATE_PERCENT = Math.round(DEFAULT_LOSS_RATE * 100);

/**
 * 実測合計に {@link DEFAULT_LOSS_RATE} のロスを加え、切り上げた発注数量を返す（検算用）。
 */
export function calculateOrderQuantity(measuredTotal: number, lossRatePercent: number): number {
  if (!Number.isFinite(measuredTotal) || measuredTotal <= 0 || !Number.isFinite(lossRatePercent) || lossRatePercent < 0) {
    return 0;
  }
  const value = measuredTotal * (1 + lossRatePercent / 100);
  if (!Number.isFinite(value)) return 0;
  const nearest = Math.round(value);
  // Correct arithmetic noise only, without rounding away meaningful extra meters.
  const tolerance = Math.max(1, Math.abs(value)) * Number.EPSILON * 8;
  return Math.abs(value - nearest) <= tolerance ? nearest : Math.ceil(value);
}

export function calculateFinalQuantity(measuredTotal: number): number {
  return calculateOrderQuantity(measuredTotal, DEFAULT_LOSS_RATE_PERCENT);
}
