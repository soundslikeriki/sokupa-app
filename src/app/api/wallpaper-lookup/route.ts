import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";

import { normalizeWallpaperProductCode } from "@/lib/area-calculation";
import { parseRepeatInfoRaw } from "@/lib/calc-logic";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { augmentProductWithCatalogSearch } from "@/lib/wallpaperCatalogSearch";

export const runtime = "nodejs";
export const maxDuration = 300;

function meaningful(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text !== "不明" && text !== "情報なし" && text !== "規格情報なし"
    ? text
    : undefined;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { product_code?: unknown };
    const rawCode = typeof body.product_code === "string" ? body.product_code : "";
    const productCode = normalizeWallpaperProductCode(rawCode);

    if (!productCode) {
      return NextResponse.json({ error: "品番を入力してください" }, { status: 400 });
    }
    if (!/^[A-Z0-9]{3,20}$/.test(productCode)) {
      return NextResponse.json({ error: "品番は英数字で入力してください" }, { status: 400 });
    }

    const apiKey =
      process.env.GEMINI_API_KEY?.trim() ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      "";
    const compatibilityClient = new GoogleGenerativeAI(apiKey || "database-cache-only");
    const augment = await augmentProductWithCatalogSearch(
      compatibilityClient,
      createSupabaseAdmin(),
      productCode,
    );

    const manufacturer = meaningful(augment.manufacturer);
    const spec = meaningful(augment.spec);
    const notes = meaningful(augment.catalog_notes_extra);
    const repeatInfo = parseRepeatInfoRaw(augment.repeat_info);
    const sourceUrl = meaningful(augment.source_url);
    const catalogName = meaningful(augment.catalog_name);
    const catalogPageNum = meaningful(augment.catalog_page_num);
    const found = Boolean(
      manufacturer ||
        spec ||
        notes ||
        meaningful(repeatInfo?.from_product) ||
        sourceUrl ||
        catalogName,
    );

    return NextResponse.json({
      data: {
        product_code: productCode,
        found,
        manufacturer,
        spec,
        repeat_info: repeatInfo,
        notes,
        source_url: sourceUrl,
        catalog_name: catalogName,
        catalog_page_num: catalogPageNum,
        is_live_searched: Boolean(augment.is_live_searched),
      },
    });
  } catch (error) {
    console.error("[wallpaper-lookup] lookup failed", error);
    return NextResponse.json({ error: "商品情報の取得に失敗しました" }, { status: 500 });
  }
}
