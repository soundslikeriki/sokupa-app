import type { MemoEntry, MemoProductItem, ParsedMemoPayload, RepeatInfo } from "@/types";

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

function subtotalFromEntry(e: MemoEntry): number {
  const sub = Number(e.subtotal_m);
  if (Number.isFinite(sub) && sub > 0) {
    return sub;
  }
  const L = Number(e.length_m) || 0;
  const q = Number(e.quantity) || 0;
  return L * q;
}

/**
 * entries から total_m を再集計し、order_quantity = ceil(total_m × (1+DEFAULT_LOSS_RATE)) でサーバー側も揃える。
 */
export function normalizeParsedMemoData(data: ParsedMemoPayload): ParsedMemoPayload {
  const items: MemoProductItem[] = data.items.map((item) => {
    const entries = (item.entries ?? []).map((e) => ({
      original_formula: String(e.original_formula ?? ""),
      length_m: Number(e.length_m) || 0,
      quantity: Number(e.quantity) || 0,
      subtotal_m: subtotalFromEntry(e),
    }));
    const totalFromEntries = entries.reduce((sum, e) => sum + e.subtotal_m, 0);
    const total_m =
      totalFromEntries > 0 ? totalFromEntries : Math.max(0, Number.isFinite(item.total_m) ? item.total_m : 0);
    const order_quantity = calculateFinalQuantity(total_m);
    const out: MemoProductItem = {
      product_code: String(item.product_code ?? "").trim(),
      manufacturer: String(item.manufacturer ?? "").trim() || "不明",
      entries,
      total_m,
      order_quantity,
    };
    const spec = String(item.spec ?? "").trim();
    if (spec) out.spec = spec;
    const repeat = parseRepeatInfoRaw(item.repeat_info as unknown);
    if (repeat) out.repeat_info = repeat;
    const itemNotes = String(item.notes ?? "").trim();
    if (itemNotes) out.notes = itemNotes;
    const c = item.confidence;
    if (typeof c === "number" && Number.isFinite(c)) {
      out.confidence = Math.min(1, Math.max(0, c));
    }
    return out;
  });

  return {
    items: items.filter((i) => i.product_code.length > 0),
    notes: data.notes,
  };
}
