export const MEMO_BUCKET = "memo_uploads";
export const MAX_MEMO_BYTES = 4 * 1024 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ownedMemoPath(value: unknown, lineUserId: string): value is string {
  if (typeof value !== "string") return false;
  const prefix = `${lineUserId}/`;
  return value.startsWith(prefix) && UUID_PATTERN.test(value.slice(prefix.length).replace(/\.jpg$/, "")) && value.endsWith(".jpg");
}

/** Existing queued jobs retain their public URL in the DB, but download via the admin SDK after cutover. */
export function memoObjectPath(value: string, supabaseUrl: string): string {
  if (!value.includes("://")) {
    if (!value || value.includes("..") || value.startsWith("/")) throw new Error("Invalid image path");
    return value;
  }
  const url = new URL(value), base = new URL(supabaseUrl);
  const prefix = `/storage/v1/object/public/${MEMO_BUCKET}/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new Error("Invalid image URL");
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!path || path.includes("..")) throw new Error("Invalid image path");
  return path;
}
