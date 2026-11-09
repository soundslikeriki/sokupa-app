import type { ParsedMemoPayload, OrderDraftItem } from "../types";
import { validMaterialId } from "./material-identity";

export type ResultSession = { version: 1; generation: number; inactive: boolean; fingerprint: string;
  meaningfulAt: unknown; observedAt: unknown; allowedJobId: string | null; reason?: "manual" | "age" | "declined";
  undo: { parsed: ParsedMemoPayload | null; originalParsed?: ParsedMemoPayload | null; resultJobId: string | null;
    resultSiteName: string; meaningfulAt: unknown; workspaceInputs?: { siteName: string; orderDraftItems: OrderDraftItem[] } } | null };

export type RecentWorkspaceDraft = { version: 1; revision: number; raw: string };

export type WorkspaceDraft = {
  version: 1 | 2;
  recentDraft?: RecentWorkspaceDraft;
  siteName: string;
  parsed: ParsedMemoPayload | null;
  originalParsed?: ParsedMemoPayload | null;
  orderDraftItems: OrderDraftItem[];
  resultJobId?: string | null;
  resultSiteName?: string;
  resultSession?: ResultSession;
};
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function memo(value: unknown): boolean {
  if (value === null) return true;
  return object(value) && ["image_needs_review", "needs_review_any"].every((key) => value[key] === undefined || typeof value[key] === "boolean") && (value.notes === undefined || typeof value.notes === "string") && Array.isArray(value.items) && value.items.length <= 1000 && value.items.every((item: unknown) =>
    object(item) && (item.client_material_id === undefined || validMaterialId(item.client_material_id)) && (item.needs_review === undefined || typeof item.needs_review === "boolean") && typeof item.product_code === "string" && typeof item.manufacturer === "string" && number(item.total_m) && number(item.order_quantity) &&
    ["notes", "spec", "catalog_name", "catalog_page_num", "source_url", "quantity_confirmation", "reading_review_confirmation", "order_quantity_input", "loss_rate_input", "repeat_cm_input", "repeat_height_input"].every((key) => item[key] === undefined || typeof item[key] === "string") &&
    (item.reading_reviews === undefined || (Array.isArray(item.reading_reviews) && item.reading_reviews.length <= 1000 && item.reading_reviews.every((review: unknown) =>
      object(review) && typeof review.reason === "string" && review.reason.length <= 20000 && Array.isArray(review.candidate_formulas) && review.candidate_formulas.length <= 1000 && review.candidate_formulas.every((formula: unknown) => typeof formula === "string" && formula.length <= 10000) &&
      (review.source_image_index === undefined || (number(review.source_image_index) && Number.isSafeInteger(review.source_image_index) && review.source_image_index < 16))))) &&
    (item.order_mode === undefined || ["memo", "pattern"].includes(item.order_mode)) &&
    (item.pattern_rows_configured === undefined || typeof item.pattern_rows_configured === "boolean") &&
    (item.memo_allowance === undefined || ["add", "included"].includes(item.memo_allowance)) &&
    (item.measurement_basis === undefined || ["unconfirmed","trim-included","repeat-adjusted"].includes(item.measurement_basis)) &&
    (item.pattern_match === undefined || ["unconfirmed","straight","other"].includes(item.pattern_match)) &&
    ["repeat_cm", "repeat_height_m", "manual_order_quantity", "loss_rate_percent"].every((key) => item[key] === undefined || number(item[key])) &&
    (!item.repeat_info || (object(item.repeat_info) && typeof item.repeat_info.from_product === "string")) &&
    (!item.tags || (Array.isArray(item.tags) && item.tags.every((tag: unknown) => typeof tag === "string"))) &&
    (!item.review_reasons || (Array.isArray(item.review_reasons) && item.review_reasons.every((reason: unknown) => typeof reason === "string"))) &&
    Array.isArray(item.entries) && item.entries.length <= 10000 && item.entries.every((entry: unknown) => object(entry) && typeof entry.original_formula === "string" && ["length_input", "quantity_input"].every(key => entry[key] === undefined || (typeof entry[key] === "string" && entry[key].length <= 100)) && number(entry.length_m) && number(entry.quantity) && number(entry.subtotal_m) && (entry.repeat_enabled === undefined || typeof entry.repeat_enabled === "boolean") && (entry.repeat_use_row_length === undefined || typeof entry.repeat_use_row_length === "boolean") && (entry.review_reason === undefined || typeof entry.review_reason === "string") && (entry.source_row_id === undefined || typeof entry.source_row_id === "string") && ["source_image_index","source_entry_index"].every(key => entry[key] === undefined || (number(entry[key]) && Number.isSafeInteger(entry[key])))));
}

function validOrderDraftItems(value: unknown): boolean {
  return !(!Array.isArray(value) || value.length > 1000 ||
      value.some((item: unknown) => !object(item) || typeof item.id !== "string" || typeof item.productCode !== "string" || !number(item.quantity) || (item.quantityInput !== undefined && (typeof item.quantityInput !== "string" || item.quantityInput.length > 100)) || typeof item.unit !== "string" || typeof item.sourceLabel !== "string" || !["manual", "area", "dimension"].includes(item.sourceType)));
}

/** Reject corrupt drafts before rendering, and let callers keep the original storage value intact. */
export function readWorkspaceDraft(text: string): WorkspaceDraft {
  if (text.length > 4_000_000) throw new Error("保存した下書きが大きすぎます。端末内のデータは保持しています。");
  const value: unknown = JSON.parse(text);
  if (!object(value) || (value.version !== 1 && value.version !== 2) || typeof value.siteName !== "string" || !memo(value.parsed) ||
      (value.resultJobId != null && (typeof value.resultJobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.resultJobId))) ||
      (value.resultSiteName !== undefined && typeof value.resultSiteName !== "string") || !validResultSession(value.resultSession) ||
      (value.originalParsed !== undefined && !memo(value.originalParsed)) || !validOrderDraftItems(value.orderDraftItems)) {
    throw new Error("保存した下書きを復元できません。端末内のデータは保持しています。");
  }
  if (value.version === 1 && value.recentDraft !== undefined || value.version === 2 && !validRecentDraft(value.recentDraft)) {
    throw new Error("直前の下書きを読み取れません。保存データは保持しています。");
  }
  return value as WorkspaceDraft;
}

function validRecentDraft(value: unknown): boolean {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.raw !== "string") return false;
  try {
    const previous = JSON.parse(value.raw);
    // Exactly one previous state; reject recursive envelopes and unknown formats.
    if (!object(previous) || previous.version !== 1 || previous.recentDraft !== undefined) return false;
    readWorkspaceDraft(value.raw); return true;
  } catch { return false; }
}

function validResultSession(value: unknown): boolean {
  const uuid = (id: unknown) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (value === undefined) return true;
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.inactive !== "boolean" ||
    typeof value.fingerprint !== "string" || value.fingerprint.length > 128 || !(value.allowedJobId === null || uuid(value.allowedJobId))) return false;
  const undo = value.undo;
  return undo === null || object(undo) && memo(undo.parsed) && (undo.parsed !== null && undo.parsed.items.length > 0 || undo.workspaceInputs !== undefined) &&
    (undo.workspaceInputs === undefined || object(undo.workspaceInputs) && typeof undo.workspaceInputs.siteName === "string" && validOrderDraftItems(undo.workspaceInputs.orderDraftItems)) &&
    (undo.originalParsed === undefined || memo(undo.originalParsed)) && typeof undo.resultSiteName === "string" &&
    (undo.resultJobId === null || uuid(undo.resultJobId));
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

export type WorkspaceArchive = { key: string; raw: string; draft: WorkspaceDraft | null; kind: "recent" | "legacy" | "deferred" | "quarantine"; revision?: number };

/** Explicit replacement consent: one atomic key update, with no new archive/history key. */
export function replaceWorkspaceDraft(storage: Pick<Storage,"getItem"|"setItem">, key: string, expectedRaw: string | null, next: WorkspaceDraft): { raw: string; archives: WorkspaceArchive[] } {
  const raw = JSON.stringify(next); readWorkspaceDraft(raw);
  if (storage.getItem(key) !== expectedRaw) throw new Error("別の画面で保存内容が変わりました。上書きしていません。");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("保存結果を確認できませんでした。");
  return { raw, archives: [] };
}

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
    return { key: archiveKey, raw: existing, draft: saved, kind: "deferred" };
  }
  storage.setItem(archiveKey, raw);
  if (storage.getItem(archiveKey) !== raw) throw new Error("保留結果の保存を確認できませんでした。");
  return { key: archiveKey, raw, draft, kind: "deferred" };
}

export function workspaceHasContent(draft: WorkspaceDraft | null): boolean {
  return Boolean(draft && (draft.parsed || draft.originalParsed || draft.orderDraftItems.length || draft.siteName.trim()));
}

export function workspaceWouldBeReplacedByResult(draft: WorkspaceDraft | null, jobId: string, siteName: string | null): boolean {
  if (!draft || workspaceContainsJobResult(draft, jobId)) return false;
  return Boolean(draft.parsed || draft.originalParsed || (draft.siteName.trim() && draft.siteName !== (siteName ?? "")));
}

/** The recent snapshot is part of the active atomic value, never a new history key. */
export function recentWorkspaceArchive(recent: RecentWorkspaceDraft | undefined, key: string): WorkspaceArchive | null {
  return recent ? { key: `${key}:recent:${recent.revision}`, raw: recent.raw, draft: readWorkspaceDraft(recent.raw), kind: "recent", revision: recent.revision } : null;
}

export function listWorkspaceArchives(storage: Pick<Storage, "getItem" | "key" | "length">, key: string): WorkspaceArchive[] {
  const archives: WorkspaceArchive[] = [];
  // Reading never migrates/deletes legacy keys or guesses chronology.
  const primary = storage.getItem(key);
  if (primary !== null) try { const recent = recentWorkspaceArchive(readWorkspaceDraft(primary).recentDraft, key); if (recent) archives.push(recent); } catch { /* Existing recovery UI preserves the unreadable primary. */ }
  const legacy: WorkspaceArchive[] = [];
  for (let i = 0; i < storage.length; i++) {
    const archiveKey = storage.key(i);
    if (!archiveKey?.startsWith(`${key}:recovery:`)) continue;
    const raw = storage.getItem(archiveKey); if (raw === null) continue;
    let draft = null;
    try { draft = readWorkspaceDraft(raw); } catch { /* Preserve invalid legacy archives for download. */ }
    legacy.push({ key: archiveKey, raw, draft, kind: draft === null ? "quarantine" : archiveKey.startsWith(`${key}:recovery:result:`) ? "deferred" : "legacy" });
  }
  // Deterministic inventory order only. Keys and edit clocks do not prove age.
  return [...archives, ...legacy.sort((a, b) => a.key.localeCompare(b.key))];
}

export function assertWorkspaceArchiveCurrent(storage: Pick<Storage, "getItem">, key: string, archive: WorkspaceArchive): void {
  if (archive.kind === "recent") {
    const raw = storage.getItem(key), current = raw === null ? null : recentWorkspaceArchive(readWorkspaceDraft(raw).recentDraft, key);
    if (!current || current.key !== archive.key || current.revision !== archive.revision || current.raw !== archive.raw) throw new Error("直前の下書きが別の画面で変わりました。選び直してください。");
  } else if (!archive.key.startsWith(`${key}:recovery:`) || storage.getItem(archive.key) !== archive.raw) {
    throw new Error("選んだ退避データが変わりました。保存内容を確認して選び直してください。");
  }
}

/** Active + previous publish atomically; a crash can never destroy the only source first. */
export function prepareWorkspaceSwitch(current: WorkspaceDraft, next: WorkspaceDraft): WorkspaceDraft {
  readWorkspaceDraft(JSON.stringify(current)); readWorkspaceDraft(JSON.stringify(next));
  const revision = (current.recentDraft?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("直前の下書きの世代を更新できません。現在の内容は保持しています。");
  const previous: WorkspaceDraft = { ...current, version: 1 }; delete previous.recentDraft;
  const prepared: WorkspaceDraft = { ...next, version: 2, recentDraft: { version: 1, revision, raw: JSON.stringify(previous) } };
  return readWorkspaceDraft(JSON.stringify(prepared));
}

/** Caller holds the owner lock. No deletion, extra archive keys or wall-clock ranking. */
export function switchWorkspaceDraft(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  expectedRaw: string | null,
  current: WorkspaceDraft,
  next: WorkspaceDraft,
  legacyAttemptId?: string,
): { raw: string; draft: WorkspaceDraft; archives: WorkspaceArchive[] } {
  void legacyAttemptId; // Retain call compatibility; no timestamp/UUID archive is created.
  if (expectedRaw !== null && JSON.stringify(readWorkspaceDraft(expectedRaw).recentDraft) !== JSON.stringify(current.recentDraft)) {
    throw new Error("直前の下書きが変わりました。現在の編集は保持しています。選び直してください。");
  }
  const prepared = prepareWorkspaceSwitch(current, next), raw = JSON.stringify(prepared);
  if (storage.getItem(key) !== expectedRaw) throw new Error("別の画面で保存内容が変わりました。今の編集は保持しています。再読み込みしてください。");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("切替後の保存を確認できません。画面の編集は保持しています。再読み込み前に書き出してください。");
  return { raw, draft: prepared, archives: [recentWorkspaceArchive(prepared.recentDraft, key)!] };
}
