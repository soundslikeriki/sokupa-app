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
export function calculateFinalQuantity(measuredTotal: number): number {
  if (!Number.isFinite(measuredTotal) || measuredTotal <= 0) {
    return 0;
  }
  return Math.ceil(measuredTotal * (1 + DEFAULT_LOSS_RATE));
}
