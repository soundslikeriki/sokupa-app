import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { code?: string };
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

    const now = new Date().toISOString();

    // One-time use: succeed only if exists AND is_used=false
    const { data, error } = await admin
      .from("invite_codes")
      .update({ is_used: true, used_at: now })
      .eq("code", code)
      .eq("is_used", false)
      .select("id")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const res = NextResponse.json({ success: true });
    // LINEログインのコールバックで users.invite_code に保存するため短期cookieに保持
    res.cookies.set("sokupa_invite_code", code, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 10, // 10min
      path: "/",
    });
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

