import { calculateOrderQuantity, DEFAULT_LOSS_RATE_PERCENT } from "./calc-logic";
import type { MemoEntry, MemoProductItem, ParsedMemoPayload } from "../types";

export const roundMeters = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** Field shorthand: length × (width count ± adjustments). Never evaluate code. */
export function evaluateMemoFormula(formula: string): { length: number; quantity: number; subtotal: number; ambiguous: boolean } | null {
  const text = formula.normalize("NFKC").replace(/[×xX＊]/g, "*").replace(/[−–—]/g, "-").replace(/\s/g, "").replace(/m/gi, "");
  const match = /^(\d+(?:\.\d+)?|\d+-\d+)\*(?:\(([\d.+-]+)\)|([\d.+-]+))$/.exec(text);
  if (!match) return null;
  const lengthText = match[1];
  const counts = match[2] ?? match[3];
  // A hyphen in the length, or a short 7-3 style count without +/parentheses, has two plausible meanings.
  const ambiguous = lengthText.includes("-") || (!match[2] && !counts.includes("+") && counts.includes("-"));
  const length = Number(lengthText.replace("-", "."));
  if (!/^\d+(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)*$/.test(counts)) return null;
  const quantity = (counts.match(/[+-]?\d+(?:\.\d+)?/g) ?? []).reduce((sum, n) => sum + Number(n), 0);
  if (!Number.isFinite(length) || !Number.isFinite(quantity) || length <= 0 || quantity < 0) return null;
  return { length, quantity, subtotal: roundMeters(length * quantity), ambiguous };
}

export function validateMemoEntry(raw: unknown): MemoEntry {
  if (!raw || typeof raw !== "object") throw new Error("計算式の読み取りに失敗しました。画像を確認してください。");
  const entry = raw as Record<string, unknown>;
  const formula = typeof entry.original_formula === "string" ? entry.original_formula.trim() : "";
  const parsed = evaluateMemoFormula(formula);
  const numeric = (value: unknown): number => typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const length = parsed?.length ?? numeric(entry.length_m), quantity = parsed?.quantity ?? numeric(entry.quantity);
  if (!Number.isFinite(length) || !Number.isFinite(quantity) || length <= 0 || quantity < 0 || !Number.isFinite(length * quantity)) {
    throw new Error("寸法・数量を読み取れませんでした。画像を確認してください。");
  }
  // Ambiguity remains a visible review item, even if the AI happened to choose one interpretation.
  const l = length, q = quantity;
  return {
    original_formula: formula, length_m: l, quantity: q, subtotal_m: roundMeters(l * q),
    ...(parsed?.ambiguous || !parsed || entry.needs_review === true ? { needs_review: true, review_reason: entry.needs_review === true ? "画像の式・寸法・幅数の読み取りを確認してください" : parsed?.ambiguous ? "ハイフンが小数表記か減算か確認してください" : "式を検算できません。原画像の寸法・数量を確認してください" } : {}),
  };
}

type VisionPayload = { items: Record<string, unknown>[]; notes?: string; image_needs_review?: boolean; needs_review?: boolean };

export function parseVisionJson(text: string): VisionPayload {
  let result: unknown;
  try {
    result = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch { throw new Error("解析結果を読み取れませんでした。画像を確認して再解析してください。"); }
  if (!result || typeof result !== "object" || !Array.isArray((result as { items?: unknown }).items)) throw new Error("解析結果の形式が不正です。");
  const payload = result as { items: unknown[]; notes?: string };
  if (!payload.items.length || payload.items.some((item) => !item || typeof item !== "object" || !Array.isArray((item as {entries?:unknown}).entries) || !(item as {entries:unknown[]}).entries.length)) {
    throw new Error("品番・計算式を読み取れませんでした。画像を確認してください。");
  }
  return payload as VisionPayload;
}

export function requiresMemoReview(payload: ParsedMemoPayload): boolean {
  return Boolean(payload.image_needs_review || payload.needs_review_any || payload.items.some((item) => item.needs_review || item.review_reasons?.length || item.entries.some((entry) => entry.needs_review)));
}

export function mergeParsedPayloads(payloads: ParsedMemoPayload[]): ParsedMemoPayload {
  const map = new Map<string, MemoProductItem>();
  for (const [imageIndex, payload] of payloads.entries()) for (const [itemIndex, item] of payload.items.entries()) {
    const imageReview = Boolean(payload.image_needs_review || payload.needs_review_any);
    const code = item.product_code.trim().toUpperCase().replace(/[\s-]+/g, "");
    const existing = map.get(code);
    const entries = [...(existing?.entries ?? []), ...item.entries.map((entry, entryIndex) => ({ ...validateMemoEntry(entry), source_row_id: `image-${imageIndex}:item-${itemIndex}:row-${entryIndex}`, source_image_index: imageIndex, source_entry_index: entryIndex }))];
    const total = roundMeters(entries.reduce((sum, entry) => sum + entry.subtotal_m, 0));
    const loss = existing?.loss_rate_percent ?? item.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT;
    const reasons = Array.from(new Set([...(existing?.review_reasons ?? []), ...(item.review_reasons ?? []), ...(imageReview ? ["画像：解析結果を原画像で確認してください"] : []), ...entries.filter((entry) => entry.needs_review).map((entry) => `式：${entry.review_reason}`)]));
    map.set(code, { ...existing, ...item, entries, total_m: total, order_quantity: calculateOrderQuantity(total, loss),
      needs_review: Boolean(imageReview || existing?.needs_review || item.needs_review || entries.some((entry) => entry.needs_review)), review_reasons: reasons });
  }
  const items = Array.from(map.values());
  return { items, notes: Array.from(new Set(payloads.map((p) => p.notes).filter(Boolean))).join("\n"), image_needs_review: payloads.some((payload) => payload.image_needs_review), needs_review_any: items.some((item) => item.needs_review) };
}

export function repeatCutLength(length: number, repeatCm: number): number {
  if (!(repeatCm > 0) || !(length > 0)) return length;
  const repeat = repeatCm / 100;
  return roundMeters(Math.ceil(length / repeat - 1e-10) * repeat);
}
