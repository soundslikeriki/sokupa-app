import { UUID_PATTERN } from "./memo-storage";
import type { WorkspaceDraft } from "./workspace-draft";
export type ReplacementConsent = { jobId: string; fingerprint: string };
const key = (owner: string) => `sokupa:replacement:v1:${encodeURIComponent(owner)}`;
export async function workspaceFingerprint(draft: WorkspaceDraft | null): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(draft)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
}
export function readReplacementConsent(storage: Pick<Storage,"getItem">, owner: string): ReplacementConsent | null {
  const raw = storage.getItem(key(owner));
  if (!raw || raw.length > 256) return null;
  try { const value = JSON.parse(raw); return value && UUID_PATTERN.test(value.jobId) && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint) ? value : null; }
  catch { return null; }
}
export function writeReplacementConsent(storage: Pick<Storage,"getItem"|"setItem">, owner: string, value: ReplacementConsent) {
  if (!UUID_PATTERN.test(value.jobId) || !/^[0-9a-f]{64}$/.test(value.fingerprint)) throw new Error("Invalid replacement intent");
  const raw = JSON.stringify(value); storage.setItem(key(owner),raw);
  if (storage.getItem(key(owner)) !== raw) throw new Error("Replacement intent was not saved");
}
/** Call inside the workspace lock: another tab's newer upload must retain its marker. */
export function forgetReplacementConsent(storage: Pick<Storage,"getItem"|"removeItem">, owner: string, jobId: string) {
  if (readReplacementConsent(storage,owner)?.jobId === jobId) storage.removeItem(key(owner));
}
