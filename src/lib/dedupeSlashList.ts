/**
 * 「防カビ / 下地注意 / 防カビ」のように `/` 区切りで重複したセグメントを除去し、順序を保って繋ぎ直す。
 */
export function dedupeSlashDelimited(input: string): string {
  if (!input || typeof input !== "string") return "";
  const parts = input.split("/").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(" / ");
}
