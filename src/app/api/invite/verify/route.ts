import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

// Vercel Edge Runtime対応のシンプルな実装
// IPアドレスは req.headers.get('x-forwarded-for') で取得
const rateLimit = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "unknown";
}

function isRateLimited(ip: string, nowMs: number): boolean {
  const windowMs = 60_000;
  const limit = 5;

  const entry = rateLimit.get(ip);
  if (!entry || nowMs >= entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: nowMs + windowMs });
    return false;
  }

  entry.count += 1;
  if (entry.count > limit) return true;

  rateLimit.set(ip, entry);
  return false;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    if (isRateLimited(ip, Date.now())) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

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

