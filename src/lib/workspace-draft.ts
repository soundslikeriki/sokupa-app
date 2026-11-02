import type { ParsedMemoPayload, OrderDraftItem } from "../types";

export type WorkspaceDraft = {
  version: 1;
  siteName: string;
  parsed: ParsedMemoPayload | null;
  originalParsed?: ParsedMemoPayload | null;
  orderDraftItems: OrderDraftItem[];
};
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function memo(value: unknown): boolean {
  if (value === null) return true;
  return object(value) && ["image_needs_review", "needs_review_any"].every((key) => value[key] === undefined || typeof value[key] === "boolean") && (value.notes === undefined || typeof value.notes === "string") && Array.isArray(value.items) && value.items.length <= 1000 && value.items.every((item: unknown) =>
    object(item) && (item.needs_review === undefined || typeof item.needs_review === "boolean") && typeof item.product_code === "string" && typeof item.manufacturer === "string" && number(item.total_m) && number(item.order_quantity) &&
    ["notes", "spec", "catalog_name", "catalog_page_num", "source_url"].every((key) => item[key] === undefined || typeof item[key] === "string") &&
    ["repeat_cm", "repeat_height_m", "manual_order_quantity", "loss_rate_percent"].every((key) => item[key] === undefined || number(item[key])) &&
    (!item.repeat_info || (object(item.repeat_info) && typeof item.repeat_info.from_product === "string")) &&
    (!item.tags || (Array.isArray(item.tags) && item.tags.every((tag: unknown) => typeof tag === "string"))) &&
    (!item.review_reasons || (Array.isArray(item.review_reasons) && item.review_reasons.every((reason: unknown) => typeof reason === "string"))) &&
    Array.isArray(item.entries) && item.entries.length <= 10000 && item.entries.every((entry: unknown) => object(entry) && typeof entry.original_formula === "string" && number(entry.length_m) && number(entry.quantity) && number(entry.subtotal_m) && (entry.repeat_enabled === undefined || typeof entry.repeat_enabled === "boolean") && (entry.review_reason === undefined || typeof entry.review_reason === "string")));
}

/** Reject corrupt drafts before rendering, and let callers keep the original storage value intact. */
export function readWorkspaceDraft(text: string): WorkspaceDraft {
  if (text.length > 4_000_000) throw new Error("保存した下書きが大きすぎます。端末内のデータは保持しています。");
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.version !== 1 || typeof value.siteName !== "string" || !memo(value.parsed) ||
      (value.originalParsed !== undefined && !memo(value.originalParsed)) || !Array.isArray(value.orderDraftItems) || value.orderDraftItems.length > 1000 ||
      value.orderDraftItems.some((item: unknown) => !object(item) || typeof item.id !== "string" || typeof item.productCode !== "string" || !number(item.quantity) || typeof item.unit !== "string" || typeof item.sourceLabel !== "string" || !["manual", "area", "dimension"].includes(item.sourceType))) {
    throw new Error("保存した下書きを復元できません。端末内のデータは保持しています。");
  }
  return value as WorkspaceDraft;
}

export function archiveWorkspaceDraft(storage: Pick<Storage, "getItem" | "setItem">, key: string, raw: string, suffix: string): string {
  if (storage.getItem(key) !== raw) throw new Error("保存データが別の画面で更新されました。再読み込みしてください。");
  const archiveKey = `${key}:recovery:${suffix}`;
  if (storage.getItem(archiveKey) !== null) throw new Error("退避先が既に存在します。再度お試しください。");
  storage.setItem(archiveKey, raw);
  if (storage.getItem(archiveKey) !== raw) throw new Error("保存データの退避を確認できませんでした。");
  return archiveKey;
}
