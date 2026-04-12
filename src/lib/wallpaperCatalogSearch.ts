import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { GoogleGenerativeAI } from "@google/generative-ai";
import { generateText, Output, stepCountIs } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const CATALOG_MODEL = "gemini-3-flash-preview";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 公式ドメイン → メーカー名（hostname 一致またはサブドメイン） */
const OFFICIAL_DOMAIN_TO_MANUFACTURER: readonly { host: string; name: string }[] = [
  { host: "sangetsu.co.jp", name: "サンゲツ" },
  { host: "lilycolor.co.jp", name: "リリカラ" },
  { host: "tokiwa.net", name: "トキワ" },
  { host: "toli.co.jp", name: "東リ" },
  { host: "runon.co.jp", name: "ルノン" },
  { host: "sincol-group.jp", name: "シンコール" },
] as const;

function manufacturerFromOfficialUrl(url: string | null | undefined): string | null {
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

/** generateText 結果から参照 URL を可能な限り集める */
function collectReferenceUrls(
  res: {
    text?: string;
    sources?: ReadonlyArray<{ sourceType?: string; url?: string }>;
    steps?: ReadonlyArray<{ sources?: ReadonlyArray<{ sourceType?: string; url?: string }> }>;
  },
  primarySourceUrl: string | undefined,
): string[] {
  const out: string[] = [];
  if (primarySourceUrl?.trim()) out.push(primarySourceUrl.trim());

  for (const step of res.steps ?? []) {
    for (const s of step.sources ?? []) {
      if (typeof s.url === "string" && s.url.trim()) out.push(s.url.trim());
    }
  }
  for (const s of res.sources ?? []) {
    if (typeof s.url === "string" && s.url.trim()) out.push(s.url.trim());
  }

  const text = res.text ?? "";
  const urlRe = /https?:\/\/[^\s\])>」'"'、,.;]+/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(text)) !== null) {
    const u = urlMatch[0].replace(/[,;.:]+$/g, "");
    if (u.startsWith("http")) out.push(u);
  }

  return Array.from(new Set(out));
}

/**
 * 複数 URL からメーカーを確定。source_url を最優先し、競合時は品番ヒューリスティックで補助。
 */
function resolveManufacturerFromOfficialDomains(
  urls: string[],
  preferredSourceUrl: string | undefined,
  productCode: string,
): string | null {
  const fromPreferred = manufacturerFromOfficialUrl(preferredSourceUrl);
  if (fromPreferred) return fromPreferred;

  const hits: string[] = [];
  for (const u of urls) {
    const n = manufacturerFromOfficialUrl(u);
    if (n) hits.push(n);
  }
  const uniq = Array.from(new Set(hits));
  if (uniq.length === 1) return uniq[0] ?? null;
  if (uniq.length > 1) {
    if (/^TWS\d/i.test(productCode) && uniq.includes("トキワ")) return "トキワ";
    return uniq[0] ?? null;
  }
  return null;
}

function applyDnsManufacturerOverride(
  augment: CatalogAugment,
  urls: string[],
  preferredSourceUrl: string | undefined,
  productCode: string,
): CatalogAugment {
  const resolved = resolveManufacturerFromOfficialDomains(urls, preferredSourceUrl, productCode);
  if (!resolved) return augment;
  return {
    ...augment,
    manufacturer: resolved,
    confidence: clamp01(Math.max(augment.confidence, 0.92)),
  };
}

const augmentResponseSchema = z.object({
  manufacturer: z.string().default(""),
  spec: z.string().default(""),
  repeat_info: z
    .object({
      from_product: z.string().default("不明"),
    })
    .default({ from_product: "不明" }),
  notes: z.string().default(""),
  confidence: z.number().default(0.5),
  needs_review: z.boolean().default(true),
  source_url: z.string().default(""),
  catalog_name: z.string().default(""),
  catalog_page_num: z.string().default(""),
});

function cacheIsFresh(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CACHE_TTL_MS;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export type CatalogAugment = {
  manufacturer?: string;
  spec?: string;
  repeat_info?: unknown;
  /** メモ AI の notes に足すカタログ側メモ */
  catalog_notes_extra?: string;
  confidence: number;
  needs_review: boolean;
  source_url?: string;
  catalog_name?: string;
  catalog_page_num?: string;
  is_live_searched?: boolean;
};

function isGarbageSpec(spec: unknown): boolean {
  const s = typeof spec === "string" ? spec.trim() : "";
  return !s || s === "規格情報なし" || s === "情報なし" || s === "不明";
}

function isGarbageNotes(notes: unknown): boolean {
  const s = typeof notes === "string" ? notes.trim() : "";
  return !s;
}

/** キャッシュとして使わない＝強制で Google 検索をやり直す行 */
function rowFailsCatalogQualityGate(row: Record<string, unknown>): boolean {
  if (isGarbageSpec(row.spec)) return true;
  const live = Boolean(row.is_live_searched);
  if (isGarbageNotes(row.notes) && !live) return true;
  const rv = Number(row.repeat_v);
  const rh = Number(row.repeat_h);
  const hasRepeatNumbers =
    (Number.isFinite(rv) && rv > 0) || (Number.isFinite(rh) && rh > 0);
  const pat = typeof row.pattern_match === "string" ? row.pattern_match.trim() : "";
  const patOk = Boolean(pat && pat !== "不明");
  if (!hasRepeatNumbers && !patOk && !live) return true;
  return false;
}

/** タテ64.1cm / ヨコ46.2 等をテキストから数値化 */
function extractRepeatCmFromText(text: string): { v: number | null; h: number | null } {
  let v: number | null = null;
  let h: number | null = null;
  if (!text) return { v, h };

  const norm = text.replace(/\u3000/g, " ");

  let m = /タテ(?:リピート)?[：:\s]*(\d+(?:\.\d+)?)\s*(?:cm|㎝|ｍｍ|mm)?/i.exec(norm);
  if (m) v = parseFloat(m[1]);

  m = /ヨコ(?:リピート)?[：:\s]*(\d+(?:\.\d+)?)\s*(?:cm|㎝|ｍｍ|mm)?/i.exec(norm);
  if (m) h = parseFloat(m[1]);

  if (v == null) {
    m = /縦[：:\s]*(\d+(?:\.\d+)?)\s*(?:cm|㎝)?/i.exec(norm);
    if (m) v = parseFloat(m[1]);
  }
  if (h == null) {
    m = /横[：:\s]*(\d+(?:\.\d+)?)\s*(?:cm|㎝)?/i.exec(norm);
    if (m) h = parseFloat(m[1]);
  }

  const mV = /(?:^|[\s,、(/])V[：:\s]*(\d+(?:\.\d+)?)/i.exec(norm);
  const mH = /(?:^|[\s,、(/])H[：:\s]*(\d+(?:\.\d+)?)/i.exec(norm);
  if (mV && v == null) v = parseFloat(mV[1]);
  if (mH && h == null) h = parseFloat(mH[1]);

  const pair = /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(?:cm|㎝)?/i.exec(norm);
  if (pair && v == null && h == null) {
    const a = parseFloat(pair[1]);
    const b = parseFloat(pair[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      v = a;
      h = b;
    }
  }

  return {
    v: v != null && Number.isFinite(v) && v > 0 ? v : null,
    h: h != null && Number.isFinite(h) && h > 0 ? h : null,
  };
}

function buildRepeatFromProduct(
  v: number | null,
  h: number | null,
  prior: string,
): Record<string, unknown> {
  const priorT = prior.trim();
  if (v != null && h != null) return { from_product: `タテ${v}cm / ヨコ${h}cm` };
  if (v != null) {
    return {
      from_product:
        priorT && priorT !== "不明" ? `${priorT}（タテ${v}cm）` : `タテ${v}cm`,
    };
  }
  if (h != null) {
    return {
      from_product:
        priorT && priorT !== "不明" ? `${priorT}（ヨコ${h}cm）` : `ヨコ${h}cm`,
    };
  }
  return priorT ? { from_product: priorT } : { from_product: "不明" };
}

function applyRepeatNormalizationToAugment(augment: CatalogAugment): CatalogAugment {
  const priorFp =
    typeof augment.repeat_info === "object" &&
    augment.repeat_info !== null &&
    "from_product" in (augment.repeat_info as object)
      ? String((augment.repeat_info as { from_product?: string }).from_product ?? "")
      : "";

  const textBlob = [
    augment.spec ?? "",
    augment.catalog_notes_extra ?? "",
    priorFp,
  ].join("\n");

  const { v, h } = extractRepeatCmFromText(textBlob);
  const repeat_info = buildRepeatFromProduct(v, h, priorFp);

  let spec = (augment.spec ?? "").trim();
  if ((v != null || h != null) && spec && !/タテ|ヨコ|cm|㎝/i.test(spec)) {
    const bit = [v != null ? `タテ${v}cm` : null, h != null ? `ヨコ${h}cm` : null]
      .filter(Boolean)
      .join(" / ");
    spec = `${spec} / リピート: ${bit}`;
  }

  return { ...augment, spec: spec.trim(), repeat_info };
}

/**
 * wallpaper_catalog を参照し、無ければ Gemini + Google 検索で取得して保存する。
 * admin が null のときは検索のみ（キャッシュ読み書きなし）。
 * 第一引数 genAI は互換のため残す（検索は Vercel AI SDK + google_search を使用）。
 */
export async function augmentProductWithCatalogSearch(
  _genAI: GoogleGenerativeAI,
  admin: SupabaseClient | null,
  rawProductCode: string,
): Promise<CatalogAugment> {
  void _genAI;
  const productCode = rawProductCode.replace(/[\s\-]+/g, "").toUpperCase();
  const fallback: CatalogAugment = {
    confidence: 0.45,
    needs_review: true,
    catalog_notes_extra: "",
    is_live_searched: false,
  };

  if (admin) {
    const { data: row, error } = await admin
      .from("wallpapers")
      .select("*, manufacturer_id, manufacturers(name), catalogs(name)")
      .eq("code", productCode)
      .maybeSingle();

    if (!error && row) {
      const r = row as Record<string, unknown>;
      const fresh = cacheIsFresh(row.updated_at as string | undefined);
      if (fresh && !rowFailsCatalogQualityGate(r)) {
        let mfgName = typeof r.manufacturer === "string" ? r.manufacturer : "";
        if (r.manufacturers && typeof r.manufacturers === "object") {
          if (Array.isArray(r.manufacturers)) mfgName = r.manufacturers[0]?.name || mfgName;
          else mfgName = (r.manufacturers as { name?: string }).name || mfgName;
        }

        let catalogName = "";
        if (r.catalogs && typeof r.catalogs === "object") {
          if (Array.isArray(r.catalogs)) catalogName = r.catalogs[0]?.name || "";
          else catalogName = (r.catalogs as { name?: string }).name || "";
        }

        const repeatParsed = {
          from_product:
            r.repeat_v || r.repeat_h
              ? `タテ${r.repeat_v || 0} ヨコ${r.repeat_h || 0}`
              : "不明",
        };

        const srcUrl = typeof r.source_url === "string" ? r.source_url : "";
        const dnsMfg = manufacturerFromOfficialUrl(srcUrl);
        const manufacturerResolved = dnsMfg || mfgName || "";

        return {
          manufacturer: manufacturerResolved,
          spec: typeof r.spec === "string" ? r.spec : "",
          repeat_info: repeatParsed,
          catalog_notes_extra: typeof r.notes === "string" ? r.notes : "",
          confidence: clamp01(Number(r.confidence) || 0.7),
          needs_review: r.confidence !== null ? Number(r.confidence) < 0.7 : false,
          source_url: typeof r.source_url === "string" ? r.source_url : undefined,
          catalog_name: catalogName || undefined,
          catalog_page_num:
            typeof r.catalog_page_num === "string"
              ? r.catalog_page_num
              : typeof r.catalog_page_num === "number"
                ? String(r.catalog_page_num)
                : undefined,
          is_live_searched: false,
        };
      }
    }
  }

  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    console.warn("augmentProductWithCatalogSearch: GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY がありません");
    return fallback;
  }

  const google = createGoogleGenerativeAI({ apiKey });

  const system = `あなたは壁紙カタログのリサーチャーです。Google 検索ツールで公式・販売店のページを調べ、品番に紐づく事実を集めます。

【メーカー推定・ブランド対応（必ず参照）】
- 検索スニペットやタイトルに次のブランド名が出たら、対応するメーカーを manufacturer に書くこと。
  - パインブル / Pine Blue / パイン・ブルー → トキワ
  - V-wall / Vウォール / Vwall → トキワ
  - リザーブ / reserve → サンゲツ
  - ライト / LIGHT（リリカラのシリーズ名としての場合）→ リリカラ
  - シリーズ略号だけでは断定せず、公式ドメインとこの対応表を最優先すること。

【公式ページの結合（最優先）】
- 検索結果にメーカー公式ドメインのページ（仕様・PDF・品番検索）が含まれる場合、そのページの表記を最優先で拾う。
- ページ内に「巾：92.5cm」「巾92.5cm」「有効幅」「防カビ」「不燃」「準不燃」などがある場合は spec に必ず含める（推測で補完してよいが公式表記を核にする）。
- タテ・ヨコのリピート寸法は公式表記を repeat_info.from_product にそのまま近い形で入れる。

【深掘り・推論の鉄則】
- メーカー公式サイトの検索結果タイトル・説明文・URL に少しでもヒント（巾、リピート、シリーズ名、機能語）があれば、確度を明示したうえで推測して JSON を埋める。空欄のまま返すのは最終手段。
- スニペットに「タテ64.1cm」「縦64.1」「V64.1」など数字がある場合は repeat_info / spec に必ず反映する。
- 無地・リピートなしと断言できる場合のみ repeat_info.from_product を「無地」とする。
- source_url には、仕様の根拠となった公式ドメインの URL を1つ入れる（推測中心なら needs_review: true と confidence を下げる）。`;

  const prompt = `品番「${productCode}」について、必ず「${productCode} 壁紙 カタログ」で検索し、メーカー公式や一次情報に近い結果を優先して読み取れ。

次の JSON スキーマにだけ従って返すこと（他の文字は禁止）:
- manufacturer: メーカー名（上記ブランド対応表・検索タイトル・URLドメインから推定。公式ドメインが分かればそれに合わせる）
- spec: 機能・巾・厚みなど短文（公式ページの「巾」「防カビ」「不燃」等を最優先で結合）
- repeat_info.from_product: 公式表記に近いリピート説明（例: タテ64.1cm / ヨコ46.2cm）。無地なら「無地」
- notes: 貼り方・注意（なければ検索で得た注意の要約でもよい）
- confidence: 0〜1
- needs_review: 推測が多いとき true
- source_url: 主根拠の URL（公式ドメインのページを優先。無ければ空文字）
- catalog_name / catalog_page_num: 分かれば`;

  let parsed: z.infer<typeof augmentResponseSchema>;
  let generateTextResult: {
    text?: string;
    sources?: ReadonlyArray<{ sourceType?: string; url?: string }>;
    steps?: ReadonlyArray<{ sources?: ReadonlyArray<{ sourceType?: string; url?: string }> }>;
  } | null = null;

  try {
    const res = await generateText({
      model: google(CATALOG_MODEL),
      tools: { google_search: google.tools.googleSearch({}) },
      stopWhen: stepCountIs(12),
      system,
      prompt,
      output: Output.object({ schema: augmentResponseSchema }),
    });
    generateTextResult = res;
    const raw = res.output;
    if (!raw) {
      console.warn("augmentProductWithCatalogSearch: empty structured output", productCode);
      return fallback;
    }
    parsed = augmentResponseSchema.parse(raw);
  } catch (e) {
    console.warn("wallpaper catalog search failed:", productCode, e);
    return fallback;
  }

  const confidence = clamp01(parsed.confidence);
  const needs_review = parsed.needs_review;

  let augment: CatalogAugment = {
    manufacturer: parsed.manufacturer.trim(),
    spec: parsed.spec.trim(),
    repeat_info: parsed.repeat_info,
    catalog_notes_extra: parsed.notes.trim(),
    confidence,
    needs_review,
    source_url: parsed.source_url.trim() || undefined,
    catalog_name: parsed.catalog_name.trim() || undefined,
    catalog_page_num: parsed.catalog_page_num.trim() || undefined,
    is_live_searched: true,
  };

  if (generateTextResult) {
    const refUrls = collectReferenceUrls(
      generateTextResult,
      augment.source_url || parsed.source_url.trim() || undefined,
    );
    augment = applyDnsManufacturerOverride(
      augment,
      refUrls,
      augment.source_url,
      productCode,
    );
  }

  augment = applyRepeatNormalizationToAugment(augment);

  const dims = extractRepeatCmFromText(
    [augment.spec, augment.catalog_notes_extra, JSON.stringify(augment.repeat_info)].join("\n"),
  );

  if (admin) {
    const { error: upErr } = await admin.from("wallpapers").upsert(
      {
        code: productCode,
        spec: augment.spec || null,
        repeat_v: dims.v,
        repeat_h: dims.h,
        notes: augment.catalog_notes_extra || null,
        confidence,
        source_url: augment.source_url || null,
        is_live_searched: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "code" },
    );
    if (upErr) {
      console.warn("wallpapers upsert:", productCode, upErr.message);
    }
  }

  return augment;
}
