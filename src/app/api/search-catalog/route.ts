import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  try {
    const { codes } = await req.json() as { codes?: string[] };
    if (!codes || !Array.isArray(codes)) {
      return NextResponse.json({ error: "Missing 'codes' array" }, { status: 400 });
    }

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase connection failed" }, { status: 500 });
    }

    // 1回のクエリでDBのwallpapersテーブルとマスタから取得
    const { data: wallpapers, error } = await admin
      .from("wallpapers")
      .select(`
        code,
        spec,
        repeat_v,
        repeat_h,
        pattern_match,
        notes,
        catalog_page_num,
        is_live_searched,
        manufacturer:manufacturers(name),
        catalog:catalogs(name)
      `)
      .in("code", codes);

    if (error) {
      console.error("Supabase search-catalog error:", error);
      return NextResponse.json({ error: "Database query failed" }, { status: 500 });
    }

    // 使いやすい形式に整形
    const results = (wallpapers || []).reduce((acc: Record<string, any>, item) => {
      acc[item.code] = {
        code: item.code,
        manufacturer: item.manufacturer ? (Array.isArray(item.manufacturer) ? item.manufacturer[0].name : (item.manufacturer as any).name) : null,
        catalogTitle: item.catalog ? (Array.isArray(item.catalog) ? item.catalog[0].name : (item.catalog as any).name) : null,
        spec: item.spec,
        repeat_v: parseFloat(item.repeat_v) || null,
        repeat_h: parseFloat(item.repeat_h) || null,
        pattern_match: item.pattern_match,
        notes: item.notes,
        catalog_page_num: item.catalog_page_num,
        is_live_searched: item.is_live_searched
      };
      return acc;
    }, {});

    return NextResponse.json({ results });
  } catch (error: unknown) {
    console.error("search-catalog api:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
