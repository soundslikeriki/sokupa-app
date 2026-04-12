import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { calculateFinalQuantity, parseRepeatInfoRaw } from "@/lib/calc-logic";
import { supabase } from "@/lib/supabase";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { augmentProductWithCatalogSearch, type CatalogAugment } from "@/lib/wallpaperCatalogSearch";
import type { MemoEntry, MemoProductItem } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_IMAGES = 16;
/** 画像解析（JSON 安定のため Google 検索ツールは付けない） */
const VISION_MODEL = "gemini-3-flash-preview";

const SYSTEM_PROMPT = `あなたは内装職人の優秀な事務員です。
計測メモ画像（手書き含む）から壁紙の品番と計算式を正確に抽出し、以下のJSON形式のみで出力してください。他の文字は一切出力しないこと。

{
  "items": [
    {
      "product_code": "品番（例: VS2067）",
      "entries": [
        {
          "original_formula": "3.20 x 6",
          "length_m": 3.20,
          "quantity": 6,
          "subtotal_m": 19.2
        }
      ],
      "total_m": 19.2
    }
  ],
  "notes": "全体の補足があればここに"
}

- 同じ品番は1つにまとめる
- 計算式は正確に数値化
- 職人は寸法を小数点でなくハイフンで書くことがあります（例：「1-30」は「1.30m」）。ハイフン付き数値は小数に変換して解釈すること。
- 品番が汚くても最大限推測`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return trimmed;
}

function normalizeImageBase64(imageBase64: string): { data: string; error?: string } {
  let raw = imageBase64.trim();
  const dataUrlMatch = /^data:([^;]+);base64,([\s\S]*)$/i.exec(raw);
  if (dataUrlMatch) {
    try {
      raw = decodeURIComponent(dataUrlMatch[2].replace(/\r?\n/g, "").replace(/\s/g, ""));
    } catch {
      raw = dataUrlMatch[2].replace(/\r?\n/g, "").replace(/\s/g, "");
    }
  } else {
    raw = raw.replace(/\r?\n/g, "").replace(/\s/g, "");
  }

  raw = raw.replace(/-/g, "+").replace(/_/g, "/");
  if (!raw) {
    return { data: "", error: "画像のBase64データが空です。" };
  }

  const invalid = raw.replace(/[A-Za-z0-9+/=]/g, "");
  if (invalid.length > 0) {
    return { data: "", error: "Base64 に不正な文字が含まれています。" };
  }

  while (raw.length % 4 !== 0) {
    raw += "=";
  }

  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 0) {
      return { data: "", error: "デコード結果が空です。画像データが欠落している可能性があります。" };
    }
  } catch {
    return { data: "", error: "Base64 のデコードに失敗しました。" };
  }

  return { data: raw };
}

function parseEntry(raw: unknown): MemoEntry {
  const e = raw as Record<string, unknown>;
  const length_m = Number(e.length_m) || 0;
  const quantity = Number(e.quantity) || 0;
  let subtotal_m = Number(e.subtotal_m) || 0;
  if (!Number.isFinite(subtotal_m) || subtotal_m <= 0) {
    subtotal_m = length_m * quantity;
  }
  return {
    original_formula: String(e.original_formula ?? ""),
    length_m,
    quantity,
    subtotal_m,
  };
}

function mergeVisionWithCatalog(item: Record<string, unknown>, cat: CatalogAugment): Record<string, unknown> {
  const visionNotes = typeof item.notes === "string" ? item.notes.trim() : "";
  const extra = cat.catalog_notes_extra?.trim() ?? "";
  const notesJoined = [visionNotes, extra].filter(Boolean).join(" / ");

  const manufacturer =
    (cat.manufacturer?.trim() || "") ||
    (typeof item.manufacturer === "string" ? item.manufacturer.trim() : "") ||
    "";

  const spec =
    (cat.spec?.trim() || "") ||
    (typeof item.spec === "string" ? String(item.spec).trim() : "") ||
    "";

  const catRi = parseRepeatInfoRaw(cat.repeat_info);
  const rawRi = parseRepeatInfoRaw(item.repeat_info);
  const repeat_info =
    catRi?.from_product?.trim() ? catRi : rawRi?.from_product?.trim() ? rawRi : { from_product: "不明" };

  return {
    ...item,
    ...(manufacturer ? { manufacturer } : {}),
    ...(spec ? { spec } : {}),
    repeat_info,
    ...(notesJoined ? { notes: notesJoined } : {}),
    confidence: cat.confidence,
    needs_review: cat.needs_review,
    is_live_searched: cat.is_live_searched,
    ...(cat.source_url ? { source_url: cat.source_url } : {}),
    ...(cat.catalog_name ? { catalog_name: cat.catalog_name } : {}),
    ...(cat.catalog_page_num ? { catalog_page_num: cat.catalog_page_num } : {}),
  };
}

type ProductMasterRow = {
  manufacturer: string | null;
  spec: string | null;
  repeat_info: unknown;
  notes: string | null;
};

async function enrichWithProductMaster(items: any[]) {
  return await Promise.all(
    items.map(async (item) => {
      const rawCode = String(item.product_code || "").trim().toUpperCase();
      const productCode = rawCode.replace(/[\s\-]+/g, "");

      if (!productCode) {
        return item;
      }

      let orQuery = `code.ilike.${productCode}`;
      const match = productCode.match(/^([A-Z]+)(\d+)$/i);
      if (match) {
        orQuery = `code.ilike.${productCode},code.ilike.${match[1]} ${match[2]},code.ilike.${match[1]}-${match[2]}`;
      }

      // 新しいテーブル構造に合わせたクエリ
      const { data: master } = await supabase
        .from('wallpapers')
        .select(`
          code,
          manufacturers(name),
          catalogs(name),
          catalog_page_num,
          spec,
          repeat_v,
          repeat_h,
          pattern_match,
          notes,
          is_live_searched,
          source_url
        `)
        .or(orQuery)
        .limit(1)
        .maybeSingle();

      if (master) {
        if (master.is_live_searched) {
          console.log(`[🔍 ネット引用] 品番: ${productCode}`);
        } else {
          console.log(`[🎯 DBヒット] 品番: ${productCode}`);
        }

        const mfgRaw = master.manufacturers as any;
        const mfgName = mfgRaw ? (Array.isArray(mfgRaw) ? mfgRaw[0]?.name : mfgRaw.name) : undefined;
        const resolvedMfg = mfgName || item.manufacturer || "不明";
        const masterSpec = String(master.spec ?? "").trim();
        const masterIsGarbage =
          !masterSpec || masterSpec === "規格情報なし" || masterSpec === "情報なし";

        const itemSpec = String(item.spec ?? "").trim();
        const itemHasRealSpec =
          Boolean(itemSpec) && itemSpec !== "規格情報なし" && itemSpec !== "情報なし";
        const preferLiveCatalog =
          Boolean(item.is_live_searched) && (itemHasRealSpec || masterIsGarbage);

        const catRaw = master.catalogs as any;
        const catalogName = catRaw ? (Array.isArray(catRaw) ? catRaw[0]?.name : catRaw.name) : undefined;

        if (preferLiveCatalog) {
          const itemRi = parseRepeatInfoRaw(item.repeat_info);
          const fromItem = itemRi?.from_product?.trim();
          const repeat_info =
            fromItem && fromItem !== "不明"
              ? itemRi!
              : master.repeat_v && master.repeat_h
                ? { from_product: `タテ${master.repeat_v} / ヨコ${master.repeat_h}` }
                : { from_product: master.pattern_match || "不明" };

          const visionNotes = typeof item.notes === "string" ? item.notes.trim() : "";
          const masterNotes = master.notes ? String(master.notes).trim() : "";
          const notesMerged = [visionNotes, masterNotes].filter(Boolean).join(" / ");

          return {
            ...item,
            product_code: master.code,
            manufacturer:
              (typeof item.manufacturer === "string" && item.manufacturer.trim()) || resolvedMfg,
            spec: itemHasRealSpec ? itemSpec : masterSpec || "規格情報なし",
            repeat_info,
            notes: notesMerged || "",
            needs_review: false,
            source_url:
              (typeof item.source_url === "string" && item.source_url.trim()) || master.source_url,
            is_live_searched: true,
            catalog_name:
              (typeof item.catalog_name === "string" && item.catalog_name.trim()) || catalogName,
            catalog_page_num:
              (typeof item.catalog_page_num === "string" && item.catalog_page_num.trim()) ||
              (master.catalog_page_num ? String(master.catalog_page_num) : undefined),
          };
        }

        const resolvedSpec = master.spec || item.spec || "規格情報なし";

        return {
          ...item,
          product_code: master.code,
          manufacturer: resolvedMfg,
          spec: resolvedSpec,
          repeat_info: master.repeat_v && master.repeat_h 
            ? { from_product: `タテ${master.repeat_v} / ヨコ${master.repeat_h}` }
            : { from_product: (master.pattern_match || "不明") },
          notes: master.notes ? `${item.notes ? item.notes + ' / ' : ''}${master.notes}` : item.notes || "",
          needs_review: false,
          source_url: master.source_url,
          is_live_searched: master.is_live_searched,
          catalog_name: catalogName,
          catalog_page_num: master.catalog_page_num ? String(master.catalog_page_num) : undefined,
        };
      } else {
        const resolvedMfg = item.manufacturer || "不明";
        const resolvedSpec = item.spec || "規格情報なし";
        const hasSomeInfo = resolvedMfg !== "不明" || resolvedSpec !== "規格情報なし";
        const isWallpaperCode = /^[A-Z]{2,3}\s*[\-]?\s*\d{3,5}$/i.test(productCode);
        
        if (hasSomeInfo || isWallpaperCode) {
          console.log(`[🔍 ネット引用 (補正/未達)] 品番: ${productCode}`);
          return {
            ...item,
            needs_review: false,
            is_live_searched: true,
          };
        } else {
          console.log(`[❌ 検索失敗] 品番: ${productCode} (DBもネットも見つかりませんでした)`);
          return {
            ...item,
            notes: (item.notes ? item.notes + ' ' : '') + "※この品番はデータベースに未登録です。",
            needs_review: true,
          };
        }
      }
    })
  );
}

function finalizeClientItem(raw: unknown): MemoProductItem | null {
  const r = raw as Record<string, unknown>;
  const product_code = String(r.product_code ?? "").trim();
  if (!product_code) return null;

  const entries = (Array.isArray(r.entries) ? r.entries : []).map(parseEntry);
  const totalFromEntries = entries.reduce((sum, e) => sum + e.subtotal_m, 0);
  const total_m = Number.isFinite(Number(r.total_m)) && Number(r.total_m) > 0 ? Number(r.total_m) : totalFromEntries;
  const order_quantity = calculateFinalQuantity(total_m);

  const manufacturer = String(r.manufacturer ?? "").trim() || "不明";
  const spec = String(r.spec ?? "").trim() || "規格情報なし";
  const repeat_info = parseRepeatInfoRaw(r.repeat_info) ?? { from_product: "不明" };
  const notesRaw = typeof r.notes === "string" ? r.notes.trim() : "";
  const notes = notesRaw || undefined;

  const conf = r.confidence;
  const confidence =
    typeof conf === "number" && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : undefined;

  const is_live_searched = Boolean(r.is_live_searched);

  let needs_review: boolean;
  if (is_live_searched) {
    // 最優先: ネットで実在確認が取れている（is_live_searched=true）なら、AIが自信0でも強制的に確定（青バッジの権利確定）
    needs_review = false;
  } else if (typeof r.needs_review === "boolean" && r.needs_review === false) {
    // DBヒット時: enrichWithProductMasterで needs_review: false に設定されていればそれに従う（緑バッジ確定）
    needs_review = false;
  } else {
    // 例外: DBにもネットにも無い（あるいは完全検索失敗）場合のみ、最終手段として推論確信度で評価
    needs_review =
      typeof r.needs_review === "boolean"
        ? r.needs_review
        : confidence !== undefined
          ? confidence < 0.55
          : true;
  }

  const out: MemoProductItem = {
    product_code,
    manufacturer,
    entries,
    total_m,
    order_quantity,
    spec,
    repeat_info,
    needs_review,
    is_live_searched,
  };

  // タグ抽出ロジック（よくある注意機能を抽出してtagsに入れる）
  const tags: string[] = [];
  if (notes) {
    out.notes = notes;
    const n = notes.replace(/\s/g, "");
    if (n.includes("下地注意") || n.includes("下地処理")) tags.push("下地注意");
    if (n.includes("防カビ")) tags.push("防カビ");
    if (n.includes("表面強化") || n.includes("強化")) tags.push("表面強化");
    if (n.includes("撥水")) tags.push("撥水");
    if (n.includes("抗菌")) tags.push("抗菌");
    if (n.includes("リフォーム推奨")) tags.push("リフォーム推奨");
  }
  if (tags.length > 0) out.tags = tags;

  if (confidence !== undefined) out.confidence = confidence;
  if (typeof r.source_url === "string" && r.source_url.trim()) out.source_url = r.source_url.trim();
  if (typeof r.catalog_name === "string" && r.catalog_name.trim()) out.catalog_name = r.catalog_name.trim();
  if (typeof r.catalog_page_num === "string" && r.catalog_page_num.trim()) out.catalog_page_num = r.catalog_page_num.trim();
  return out;
}

type ContentPart = string | { inlineData: { data: string; mimeType: string } };

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      base64Images?: string[];
      base64Image?: string;
      imageBase64?: string;
      mimeType?: string;
    };

    let base64Images: string[] = Array.isArray(body.base64Images)
      ? body.base64Images.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];

    if (base64Images.length === 0) {
      const single = body.base64Image ?? body.imageBase64;
      if (typeof single === "string" && single.trim().length > 0) {
        base64Images = [single];
      }
    }

    if (!base64Images || base64Images.length === 0) {
      return NextResponse.json({ error: "画像が必要です" }, { status: 400 });
    }

    if (base64Images.length > MAX_IMAGES) {
      return NextResponse.json({ error: `画像は最大${MAX_IMAGES}枚までです` }, { status: 400 });
    }

    const apiKey =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim();

    if (!apiKey) {
      console.error("[ERROR] Missing Env Vars: GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY is required but not set in Vercel.");
      return NextResponse.json({ 
        error: "サーバーサイドの環境変数が設定されていません。「GOOGLE_GENERATIVE_AI_API_KEY」または「GEMINI_API_KEY」を Vercel に追加してください。" 
      }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const visionModel = genAI.getGenerativeModel({
      model: VISION_MODEL,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });

    const rawMime = body.mimeType === "image/jpg" ? "image/jpeg" : body.mimeType ?? "image/jpeg";
    const mimeType =
      rawMime && ["image/jpeg", "image/png", "image/webp"].includes(rawMime) ? rawMime : "image/jpeg";

    const contents: ContentPart[] = [SYSTEM_PROMPT];

    for (const base64 of base64Images) {
      const normalized = normalizeImageBase64(base64 || "");
      if (normalized.error) {
        return NextResponse.json({ error: normalized.error }, { status: 400 });
      }
      contents.push({
        inlineData: { data: normalized.data, mimeType },
      });
    }

    const result = await visionModel.generateContent(contents);
    const responseText = result.response.text();

    let parsedData: { items?: unknown[]; notes?: string };
    try {
      parsedData = JSON.parse(stripJsonFence(responseText.trim())) as typeof parsedData;
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/);
      parsedData = match ? (JSON.parse(stripJsonFence(match[0].trim())) as typeof parsedData) : { items: [] };
    }

    const rawItems = Array.isArray(parsedData.items) ? parsedData.items : [];

    const admin = createSupabaseAdmin();
    const withCatalog = await Promise.all(
      rawItems.map(async (raw) => {
        const item = raw as Record<string, unknown>;
        const code = String(item.product_code ?? "").trim();
        if (!code) {
          return item;
        }
        const aug = await augmentProductWithCatalogSearch(genAI, admin, code);
        return mergeVisionWithCatalog(item, aug);
      })
    );

    const hasSupabaseAnon =
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) &&
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim());

    const mergedRaw = hasSupabaseAnon
      ? await enrichWithProductMaster(withCatalog)
      : withCatalog;

    const items: MemoProductItem[] = mergedRaw
      .map((row) => finalizeClientItem(row))
      .filter((x): x is MemoProductItem => x != null);

    const notes =
      typeof parsedData.notes === "string" && parsedData.notes.trim() ? parsedData.notes.trim() : undefined;

    const needs_review_any = items.some((i) => i.needs_review);

    return NextResponse.json({
      success: true,
      data: {
        items,
        notes: notes ?? "",
        needs_review_any,
      },
      imageCount: base64Images.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "画像解析に失敗しました";
    console.error("Parse Memo Error:", error);
    return NextResponse.json({ error: message || "画像解析に失敗しました" }, { status: 500 });
  }
}
