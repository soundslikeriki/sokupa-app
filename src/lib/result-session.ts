import { readWorkspaceDraft, type ResultSession, type WorkspaceDraft } from "./workspace-draft";
import { saveLatestWorkspaceSnapshot } from "./latest-workspace";

export const RESULT_DAY_MS = 24 * 60 * 60 * 1000;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const generation = (session?: ResultSession) => {
  const next = (session?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("復元情報の世代を更新できません。現在の結果は保持しています。");
  return next;
};

export function resultAgePolicy(session: ResultSession | undefined, now: number): "show" | "confirm" | "hide" | "inactive" {
  if (session?.inactive) return "inactive";
  if (!time(now) || !time(session?.meaningfulAt) || !time(session?.observedAt) || now < session.meaningfulAt || now < session.observedAt) return "confirm";
  const age = now - session.meaningfulAt;
  return age < RESULT_DAY_MS ? "show" : age < 2 * RESULT_DAY_MS ? "confirm" : "hide";
}

export function resultMayApply(session: ResultSession | undefined, jobId: string): boolean {
  return !session?.inactive || session.allowedJobId === jobId;
}

export function allowResultJob(session: ResultSession | undefined, jobId: string): ResultSession | undefined {
  return session?.inactive ? { ...session, allowedJobId: jobId } : session;
}

export function activateResultSession(session: ResultSession | undefined): ResultSession | undefined {
  return session ? { ...session, inactive: false, allowedJobId: null } : undefined;
}

/** Raw unfinished values are saved too, including before the editor first mounts. */
export function hasUnfinishedResultInput(draft: Pick<WorkspaceDraft, "parsed">): boolean {
  return Boolean(draft.parsed?.items.some(item =>
    [item.order_quantity_input, item.repeat_cm_input, item.repeat_height_input, item.loss_rate_input].some(value => value !== undefined) ||
    item.entries.some(entry => entry.length_input !== undefined || entry.quantity_input !== undefined)));
}

/** A second tab merely observing the same saved result is not an edit conflict. */
export function isObservationOnlyChange(previousRaw: string | null, nextRaw: string | null): boolean {
  if (!previousRaw || !nextRaw) return false;
  try {
    const previous = readWorkspaceDraft(previousRaw), next = readWorkspaceDraft(nextRaw);
    if (!previous.resultSession || !next.resultSession || !time(previous.resultSession.observedAt) ||
      !time(next.resultSession.observedAt) || next.resultSession.observedAt < previous.resultSession.observedAt) return false;
    const withoutObservation = (draft: WorkspaceDraft) => JSON.stringify({ ...draft, resultSession: { ...draft.resultSession, observedAt: null } });
    return withoutObservation(previous) === withoutObservation(next);
  } catch { return false; }
}

export async function resultFingerprint(draft: WorkspaceDraft): Promise<string> {
  const value = JSON.stringify({ parsed: draft.parsed, originalParsed: draft.originalParsed ?? draft.parsed,
    job: draft.resultJobId ?? null, site: draft.resultSiteName ?? draft.siteName });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Only an actual result edit or explicit resume advances meaningfulAt. */
export async function stampResultSession(draft: WorkspaceDraft, now: number, meaningful: boolean): Promise<WorkspaceDraft> {
  if (!draft.parsed) return draft;
  const fingerprint = await resultFingerprint(draft), previous = draft.resultSession;
  const backwards = time(previous?.observedAt) && (!time(now) || now < previous.observedAt);
  const changed = meaningful && previous?.fingerprint !== fingerprint;
  const session: ResultSession = { version: 1, generation: previous?.generation ?? 0,
    meaningfulAt: changed ? backwards || !time(now) ? null : now : previous?.meaningfulAt ?? null,
    observedAt: backwards ? previous!.observedAt : changed || previous?.observedAt === undefined ? time(now) ? now : null : previous.observedAt,
    fingerprint, inactive: false, allowedJobId: null, undo: previous?.undo ?? null };
  return { ...draft, resultSiteName: draft.resultSiteName ?? draft.siteName, resultSession: session };
}

/** One atomic workspace value contains both the blank display and its single undo. */
export function resetResultDraft(draft: WorkspaceDraft, now: number, reason: "manual" | "age" | "declined" = "manual"): WorkspaceDraft {
  readWorkspaceDraft(JSON.stringify(draft));
  if (!draft.parsed?.items.length) throw new Error("リセットする結果がありません。");
  const undo = { parsed: copy(draft.parsed), originalParsed: copy(draft.originalParsed ?? draft.parsed),
    resultJobId: draft.resultJobId ?? null, resultSiteName: draft.resultSiteName ?? draft.siteName,
    meaningfulAt: draft.resultSession?.meaningfulAt ?? null };
  const next: WorkspaceDraft = { ...draft, parsed: null, originalParsed: null, resultJobId: null, resultSiteName: "",
    resultSession: { version: 1, generation: generation(draft.resultSession), inactive: true, fingerprint: "",
      meaningfulAt: null, observedAt: time(now) ? now : null, allowedJobId: null, undo, reason } };
  return readWorkspaceDraft(JSON.stringify(next));
}

/** Result-only restore deliberately preserves the next-input site and order drafts. */
export async function restoreResultDraft(draft: WorkspaceDraft, now: number): Promise<WorkspaceDraft> {
  readWorkspaceDraft(JSON.stringify(draft));
  if (draft.parsed) throw new Error("現在の結果を保持するため、表示が空のときだけ戻せます。");
  const undo = draft.resultSession?.undo;
  if (!undo) throw new Error("戻せる結果がありません。");
  if (!time(now)) throw new Error("端末の時刻を確認してください。保存は保持しています。");
  const next: WorkspaceDraft = { ...draft, parsed: copy(undo.parsed), originalParsed: copy(undo.originalParsed ?? undo.parsed),
    resultJobId: undo.resultJobId ?? null, resultSiteName: undo.resultSiteName,
    resultSession: { version: 1, generation: generation(draft.resultSession), inactive: false, fingerprint: "",
      meaningfulAt: now, observedAt: now, allowedJobId: null, undo: null } };
  next.resultSession!.fingerprint = await resultFingerprint(next);
  return readWorkspaceDraft(JSON.stringify(next));
}

export async function resumeResultDraft(draft: WorkspaceDraft, now: number): Promise<WorkspaceDraft> {
  if (!draft.parsed || !time(now)) throw new Error("結果または端末の時刻を確認してください。");
  const next = { ...draft, resultSiteName: draft.resultSiteName ?? draft.siteName,
    resultSession: { version: 1 as const, generation: generation(draft.resultSession), inactive: false,
      fingerprint: "", meaningfulAt: now, observedAt: now, allowedJobId: null, undo: draft.resultSession?.undo ?? null } };
  next.resultSession.fingerprint = await resultFingerprint(next);
  return readWorkspaceDraft(JSON.stringify(next));
}

/** Caller holds the owner's workspace lock. Never change the UI until this returns. */
export async function commitResultTransition(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, owner: string,
  expectedRaw: string | null, next: WorkspaceDraft): Promise<string> {
  const key = `sokupa:workspace:v1:${owner}`, latestKey = `sokupa:latest-result:v1:${encodeURIComponent(owner)}`;
  const raw = JSON.stringify(next); readWorkspaceDraft(raw);
  if (storage.getItem(key) !== expectedRaw) throw new Error("別の画面で保存内容が変わりました。現在の結果は保持しています。");
  const previousLatest = storage.getItem(latestKey);
  try {
    await saveLatestWorkspaceSnapshot(storage, owner, next);
    if (storage.getItem(key) !== expectedRaw) throw new Error("保存中に別の画面で更新されました。");
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error("保存結果を確認できませんでした。");
    return raw;
  } catch (error) {
    // Cooperating writers use the same lock. A competing primary value is never rolled back.
    const current = storage.getItem(key);
    if (current === expectedRaw || current === raw) {
      try {
        if (current === raw) { if (expectedRaw === null) storage.removeItem(key); else storage.setItem(key, expectedRaw); }
        if (previousLatest === null) storage.removeItem(latestKey); else storage.setItem(latestKey, previousLatest);
      } catch { /* Keep the screen and explicit error; a saved recovery copy remains available. */ }
    }
    throw error;
  }
}
