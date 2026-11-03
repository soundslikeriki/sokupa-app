import type { ParsedMemoPayload, OrderDraftItem } from "../types";

export type WorkspaceDraft = {
  version: 1;
  siteName: string;
  parsed: ParsedMemoPayload | null;
  originalParsed?: ParsedMemoPayload | null;
  orderDraftItems: OrderDraftItem[];
  resultJobId?: string | null;
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
      (value.resultJobId != null && (typeof value.resultJobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.resultJobId))) ||
      (value.originalParsed !== undefined && !memo(value.originalParsed)) || !Array.isArray(value.orderDraftItems) || value.orderDraftItems.length > 1000 ||
      value.orderDraftItems.some((item: unknown) => !object(item) || typeof item.id !== "string" || typeof item.productCode !== "string" || !number(item.quantity) || typeof item.unit !== "string" || typeof item.sourceLabel !== "string" || !["manual", "area", "dimension"].includes(item.sourceType))) {
    throw new Error("保存した下書きを復元できません。端末内のデータは保持しています。");
  }
  return value as WorkspaceDraft;
}

/** Only an explicit saved job ID proves association; identical OCR content does not. */
export function workspaceContainsJobResult(draft: WorkspaceDraft | null, jobId: string): boolean {
  if (!draft?.parsed) return false;
  return Boolean(draft.resultJobId && draft.resultJobId.toLowerCase() === jobId.toLowerCase());
}

export function archiveWorkspaceDraft(storage: Pick<Storage, "getItem" | "setItem">, key: string, raw: string, suffix: string): string {
  if (storage.getItem(key) !== raw) throw new Error("保存データが別の画面で更新されました。再読み込みしてください。");
  const archiveKey = `${key}:recovery:${suffix}`;
  if (storage.getItem(archiveKey) !== null) throw new Error("退避先が既に存在します。再度お試しください。");
  storage.setItem(archiveKey, raw);
  if (storage.getItem(archiveKey) !== raw) throw new Error("保存データの退避を確認できませんでした。");
  return archiveKey;
}

export type WorkspaceArchive = { key: string; raw: string; draft: WorkspaceDraft | null };

/** A remote seen receipt cannot remove this device's explicitly postponed result. */
export function retainDeferredJobResult(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  jobId: string,
  siteName: string | null,
  result: ParsedMemoPayload,
): WorkspaceArchive {
  const draft: WorkspaceDraft = { version: 1, siteName: siteName ?? "", parsed: result, originalParsed: result, orderDraftItems: [], resultJobId: jobId };
  const raw = JSON.stringify(draft);
  readWorkspaceDraft(raw);
  const archiveKey = `${key}:recovery:result:${jobId}`;
  const existing = storage.getItem(archiveKey);
  if (existing !== null) {
    const saved = readWorkspaceDraft(existing);
    if (!workspaceContainsJobResult(saved, jobId)) throw new Error("保留結果の保存先が変わっています。書き出して保管してください。");
    return { key: archiveKey, raw: existing, draft: saved };
  }
  storage.setItem(archiveKey, raw);
  if (storage.getItem(archiveKey) !== raw) throw new Error("保留結果の保存を確認できませんでした。");
  return { key: archiveKey, raw, draft };
}

export function workspaceHasContent(draft: WorkspaceDraft | null): boolean {
  return Boolean(draft && (draft.parsed || draft.originalParsed || draft.orderDraftItems.length || draft.siteName.trim()));
}

export function workspaceWouldBeReplacedByResult(draft: WorkspaceDraft | null, jobId: string, siteName: string | null): boolean {
  if (!draft || workspaceContainsJobResult(draft, jobId)) return false;
  return Boolean(draft.parsed || draft.originalParsed || (draft.siteName.trim() && draft.siteName !== (siteName ?? "")));
}

export function listWorkspaceArchives(storage: Pick<Storage, "getItem" | "key" | "length">, key: string): WorkspaceArchive[] {
  const archives: WorkspaceArchive[] = [];
  for (let i = 0; i < storage.length; i++) {
    const archiveKey = storage.key(i);
    if (!archiveKey?.startsWith(`${key}:recovery:`)) continue;
    const raw = storage.getItem(archiveKey);
    if (raw === null) continue;
    let draft = null;
    try { draft = readWorkspaceDraft(raw); } catch { /* Preserve invalid legacy archives for download. */ }
    archives.push({ key: archiveKey, raw, draft });
  }
  return archives.sort((a, b) => b.key.localeCompare(a.key));
}

/** Verified snapshots precede the one-key replacement. A failed archive never writes the main key. */
export function switchWorkspaceDraft(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  expectedRaw: string | null,
  current: WorkspaceDraft,
  next: WorkspaceDraft,
  suffix: string,
): { raw: string; archives: WorkspaceArchive[] } {
  if (storage.getItem(key) !== expectedRaw) throw new Error("別の画面で保存内容が変わりました。今の下書きを書き出してから再読込してください。");
  const currentRaw = JSON.stringify(current), nextRaw = JSON.stringify(next);
  readWorkspaceDraft(currentRaw); readWorkspaceDraft(nextRaw);
  const snapshots = Array.from(new Set([...(expectedRaw === null ? [] : [expectedRaw]), currentRaw]));
  const archives: WorkspaceArchive[] = [];
  for (let index = 0; index < snapshots.length; index++) {
    const raw = snapshots[index];
    const archiveKey = `${key}:recovery:${suffix}:${index}`;
    const existing = storage.getItem(archiveKey);
    if (existing !== null && existing !== raw) throw new Error("退避先が更新されています。切替をやり直してください。");
    if (existing === null) storage.setItem(archiveKey, raw);
    if (storage.getItem(archiveKey) !== raw) throw new Error("下書きの退避を確認できませんでした。");
    let draft = null;
    try { draft = readWorkspaceDraft(raw); } catch { /* The exact original bytes are still preserved. */ }
    archives.push({ key: archiveKey, raw, draft });
  }
  if (storage.getItem(key) !== expectedRaw) throw new Error("退避中に別の画面で保存内容が変わりました。上書きしていません。");
  storage.setItem(key, nextRaw);
  if (storage.getItem(key) !== nextRaw) throw new Error("切替後の保存を確認できませんでした。退避した下書きは保持しています。");
  return { raw: nextRaw, archives };
}
