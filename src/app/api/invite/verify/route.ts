import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { sameOrigin } from "@/lib/server-auth";
import { INVITE_COOKIE, secureCookieOptions, signToken } from "@/lib/session-token";

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
    if (!sameOrigin(req)) return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
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


    // Check availability. Registration consumes the code only after LINE identity verification.
    const { data, error } = await admin
      .from("invite_codes")
      .select("id")
      .eq("code", code)
      .eq("is_used", false)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Consume only after verified LINE login, atomically with account creation.
    const res = NextResponse.json({ success: true });
    res.cookies.set(INVITE_COOKIE, signToken("invite", code, 60 * 30), { ...secureCookieOptions, maxAge: 60 * 30 });
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

