import { generateObject, generateText, Output, stepCountIs } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { DEFAULT_LOSS_RATE } from "@/lib/calc-logic";
import { dedupeSlashDelimited } from "@/lib/dedupeSlashList";
import { manufacturerFromOfficialUrl } from "@/lib/officialDomainManufacturer";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 120;

const OFFICIAL_DOMAINS = [
  "sangetsu.co.jp",
  "lilycolor.co.jp",
  "tokiwa.net",
  "toli.co.jp",
  "runon.co.jp",
  "sincol-group.jp",
] as const;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const extractionSchema = z.object({
  items: z.array(
    z.object({
      code: z.string(),
      amount_m: z.number(),
    }),
  ),
});

const analysisSchema = z.object({
  manufacturer: z.string(),
  repeat_v: z.number().nullable(),
  repeat_h: z.number().nullable(),
  is_plain: z.boolean(),
  is_verified: z.boolean(),
  confidence: z.number().min(0).max(1),
  source_url: z.string().nullable(),
  note: z.string(),
});

function cacheIsFresh(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CACHE_TTL_MS;
}

function sourceUrlIsOfficial(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function applyOfficialDomainGate<T extends z.infer<typeof analysisSchema>>(spec: T): T {
  const ok = sourceUrlIsOfficial(spec.source_url);
  if (ok) return spec;
  return {
    ...spec,
    is_verified: false,
    confidence: Math.min(spec.confidence, 0.45),
    note:
      (spec.note ? `${spec.note} ` : "") +
      "（source_url が公式ドメインリストに含まれないため is_verified=false に矯正）",
  };
}

type CachedAnalysis = z.infer<typeof analysisSchema>;

export async function POST(req: NextRequest) {
  try {
    const apiKey =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "GOOGLE_GENERATIVE_AI_API_KEY または GEMINI_API_KEY が未設定です" },
        { status: 500 },
      );
    }

    const google = createGoogleGenerativeAI({ apiKey });
    const body = (await req.json()) as { rawTextFromOcr?: string; siteName?: string };
    const rawTextFromOcr = typeof body.rawTextFromOcr === "string" ? body.rawTextFromOcr : "";
    const siteName = typeof body.siteName === "string" && body.siteName.trim() ? body.siteName.trim() : "北糀谷";

    if (!rawTextFromOcr.trim()) {
      return NextResponse.json({ error: "rawTextFromOcr が必要です" }, { status: 400 });
    }

    const extraction = await generateObject({
      model: google("gemini-3-flash-preview"),
      system:
        "計測メモ（壁紙発注メモ）から品番と数量（メートル）を抽出する。品番のハイフン有無・スペースは正規化する。JSON スキーマに厳密に従う。",
      prompt: rawTextFromOcr,
      schema: extractionSchema,
    });

    const admin = createSupabaseAdmin();

    const results = await Promise.all(
      extraction.object.items.map(async (item) => {
        const code = item.code.trim();
        const base_amount = item.amount_m;
        const safety_margin = 1 + DEFAULT_LOSS_RATE;

        let spec: CachedAnalysis | null = null;
        let from_cache = false;

        if (admin) {
          // 1. まず新しいデータバンク(wallpapers)を検索
          const { data: dbWall, error: dbErr } = await admin
             .from("wallpapers")
             .select("spec, repeat_v, repeat_h, pattern_match, notes, source_url, confidence, manufacturer_id, manufacturers(name)")
             .eq("code", code)
             .maybeSingle();

          if (!dbErr && dbWall) {
             const v = parseFloat(dbWall.repeat_v) || 0;
             const h = parseFloat(dbWall.repeat_h) || 0;
             let mfgName = "不明";
             if (dbWall.manufacturers && typeof dbWall.manufacturers === "object") {
               if (Array.isArray(dbWall.manufacturers)) mfgName = dbWall.manufacturers[0]?.name || mfgName;
               else mfgName = (dbWall.manufacturers as any).name || mfgName;
             }

             const srcUrl = dbWall.source_url || null;
             const dnsMfg = manufacturerFromOfficialUrl(typeof srcUrl === "string" ? srcUrl : null);
             spec = {
               manufacturer: (dnsMfg || mfgName).trim() || "不明",
               repeat_v: v > 0 ? v : null,
               repeat_h: h > 0 ? h : null,
               is_plain: v === 0 && h === 0,
               is_verified: true,
               confidence: dbWall.confidence ?? 1.0,
               source_url: srcUrl,
               note: dedupeSlashDelimited(
                 [dbWall.spec, dbWall.pattern_match, dbWall.notes].filter(Boolean).join(" / "),
               ),
             };
             from_cache = true;
          }

          // 2. ダメなら既存の ocr_order_cache を参照
          if (!spec) {
            const { data: row, error } = await admin
              .from("ocr_order_cache")
              .select("result, updated_at")
              .eq("product_code", code)
              .maybeSingle();
            if (!error && row && cacheIsFresh(row.updated_at as string)) {
              const parsed = analysisSchema.safeParse(row.result);
              if (parsed.success) {
                spec = applyOfficialDomainGate(parsed.data);
                from_cache = true;
              }
            }
          }
        }

        if (!spec) {
          const analysis = await generateText({
            model: google("gemini-3-flash-preview"),
            tools: { google_search: google.tools.googleSearch({}) },
            stopWhen: stepCountIs(10),
            system: `
あなたは内装発注ミスをゼロにする専門家です。
品番 "${code}" のカタログスペックを特定せよ。

【判定ルール】
- 検索結果の URL が次のいずれかのドメイン（またはそのサブドメイン）に含まれる場合のみ is_verified を true にしてよい:
  ${OFFICIAL_DOMAINS.join(", ")}
- リピート値がスニペット内で矛盾している場合は confidence を下げよ。
- 確証がない情報は is_verified: false とし、note に理由を記せ。
- source_url は検証に使った公式ページの URL を1つ。無ければ null。
`,
            prompt: `${code} のメーカー名、巾（cm）、タテリピート（cm）、ヨコリピート（cm）、無地かどうかを特定せよ。`,
            output: Output.object({ schema: analysisSchema }),
          });

          const raw = analysis.output;
          spec = applyOfficialDomainGate(raw);

          if (admin) {
            // Live Searchの結果を新しいデータバンク（wallpapers）にupsert
            const { error: upErr } = await admin.from("wallpapers").upsert(
              {
                code: code,
                repeat_v: spec.repeat_v?.toString() || null,
                repeat_h: spec.repeat_h?.toString() || null,
                notes: spec.note || null,
                source_url: spec.source_url || null,
                confidence: spec.confidence,
                is_live_searched: true,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "code" },
            );
            if (upErr) {
              console.warn("wallpapers upsert error:", code, upErr.message);
            }
          }
        }

        const repeat_v = spec.repeat_v || 0;
        const calculated_total =
          repeat_v > 0
            ? Math.ceil(base_amount * safety_margin + (repeat_v / 100) * (base_amount / 2.5))
            : Math.ceil(base_amount * safety_margin);

        return {
          siteName,
          code,
          original_amount: base_amount,
          final_order_amount: calculated_total,
          spec,
          needs_manual_check: !spec.is_verified || spec.confidence < 0.7,
          from_cache,
        };
      }),
    );

    return NextResponse.json(results);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "order-from-ocr でエラーが発生しました";
    console.error("order-from-ocr:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
