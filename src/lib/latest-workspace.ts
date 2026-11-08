import { createLatestResultRecovery, type Snapshot } from "./calculation/latest-result-recovery.mjs";
import { readWorkspaceDraft, type WorkspaceDraft } from "./workspace-draft";

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
// These operations run inside the same outer Web Lock as the compatible workspace writer.
const heldLock = { request: async (_name: string, _options: {mode: string}, operation: () => unknown) => operation() };
function service(storage: StorageAccess, ownerId: string) { return createLatestResultRecovery({ ownerId, storage, locks: heldLock, maxBytes: 4_000_000, allowEmptySnapshots: true }); }

export async function withWorkspaceLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
  if (!navigator.locks?.request) throw new Error("このブラウザでは安全な同時保存を利用できません。内容を書き出して保管してください。");
  return navigator.locks.request(`${key}:write`, { mode: "exclusive" }, operation);
}

/** Fixed, bounded snapshot. No image bytes and no history keys are accumulated. */
export async function saveLatestWorkspaceSnapshot(storage: StorageAccess, ownerId: string, draft: WorkspaceDraft): Promise<void> {
  readWorkspaceDraft(JSON.stringify(draft));
  if (!draft.parsed && !draft.resultSession?.undo && !draft.resultSession?.inactive) return;
  const clean = JSON.parse(JSON.stringify(draft)) as WorkspaceDraft;
  const snapshot: Snapshot = { parsed: clean.parsed ?? clean.resultSession?.undo?.parsed ?? { items: [] }, editorState: { originalParsed: clean.originalParsed ?? clean.resultSession?.undo?.originalParsed ?? clean.parsed, orderDraftItems: clean.orderDraftItems }, context: { siteName: clean.siteName, resultJobId: clean.resultJobId ?? null,
    ...(!clean.parsed ? { inactiveDisplay: true } : {}),
    ...(clean.resultSiteName !== undefined ? { resultSiteName: clean.resultSiteName } : {}), ...(clean.resultSession ? { resultSession: clean.resultSession } : {}) } };
  const store = service(storage, ownerId), restored = await store.restore();
  if (restored.status !== "restored") throw new Error("最新結果の保存先を確認できません。既存の保存内容は保持しています。");
  const operationId = !draft.parsed ? `reset:${draft.resultSession!.generation}` : draft.resultJobId ?? "legacy-current-workspace";
  let saved;
  if (restored.latest?.token.operationId === operationId) saved = await store.edit(restored.latest.token, restored.latest.revision, snapshot);
  else {
    // Do not replace a valid result with an empty new upload/editor.
    if (snapshot.parsed.items.length === 0 && !clean.resultSession?.inactive) return;
    const begun = await store.begin(operationId);
    if (begun.status !== "started" || !begun.token) throw new Error("最新結果の保存を開始できませんでした。");
    saved = await store.complete(begun.token, snapshot);
  }
  if (saved.status !== "saved") throw new Error("最新結果を保存できませんでした。内容を書き出して保管してください。");
}

/** Read only; never replace a valid workspace with a different job implicitly. */
export async function restoreLatestWorkspaceSnapshot(storage: StorageAccess, ownerId: string): Promise<WorkspaceDraft | null> {
  const restored = await service(storage, ownerId).restore();
  if (restored.status !== "restored") throw new Error("最新結果の復元保存を読み取れませんでした。");
  if (!restored.latest) return null;
  const { parsed, editorState, context } = restored.latest.snapshot;
  return readWorkspaceDraft(JSON.stringify({ version: 1, parsed: context.inactiveDisplay ? null : parsed, originalParsed: context.inactiveDisplay ? null : editorState.originalParsed, orderDraftItems: editorState.orderDraftItems, siteName: context.siteName, resultJobId: context.resultJobId, resultSiteName: context.resultSiteName, resultSession: context.resultSession }));
}

/** Explicit repair only. Preserve the exact old bytes in one bounded quarantine slot. */
export async function rebuildLatestWorkspaceSnapshot(storage: StorageAccess & Pick<Storage,"removeItem">, ownerId: string, draft: WorkspaceDraft): Promise<void> {
  readWorkspaceDraft(JSON.stringify(draft));
  const key = service(storage, ownerId).key, raw = storage.getItem(key), quarantine = `${key}:unreadable`;
  if (raw !== null) {
    const existing = storage.getItem(quarantine);
    if (existing !== null && existing !== raw) throw new Error("以前に退避した保存データがあります。先に書き出して保管してください。");
    storage.setItem(quarantine, raw);
    if (storage.getItem(quarantine) !== raw || storage.getItem(key) !== raw) throw new Error("元の保存データを保全できませんでした。");
    storage.removeItem(key);
  }
  await saveLatestWorkspaceSnapshot(storage, ownerId, draft);
}
