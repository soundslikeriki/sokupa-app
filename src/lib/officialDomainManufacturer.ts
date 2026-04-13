/** 公式ドメイン → メーカー名（hostname 一致または *.domain） */
export const OFFICIAL_DOMAIN_TO_MANUFACTURER: readonly { host: string; name: string }[] = [
  { host: "sangetsu.co.jp", name: "サンゲツ" },
  { host: "lilycolor.co.jp", name: "リリカラ" },
  { host: "tokiwa.net", name: "トキワ" },
  { host: "toli.co.jp", name: "東リ" },
  { host: "runon.co.jp", name: "ルノン" },
  { host: "sincol-group.jp", name: "シンコール" },
  { host: "abc-t.co.jp", name: "エービーシー商会" },
] as const;

export function manufacturerFromOfficialUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    for (const { host: h, name } of OFFICIAL_DOMAIN_TO_MANUFACTURER) {
      if (host === h || host.endsWith(`.${h}`)) return name;
    }
  } catch {
    return null;
  }
  return null;
}
