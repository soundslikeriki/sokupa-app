import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { SESSION_COOKIE, verifyToken } from "@/lib/session-token";
import { readQaRuntime } from "./qa-runtime";

// Preserve the existing owner's identity; never accept a role or LINE ID from the client.
export function isAdmin(lineUserId: string): boolean {
  return lineUserId === (process.env.ADMIN_LINE_USER_ID?.trim() || "U24ce93805aa15b7601a5da448fc2d354");
}

export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  return Boolean(origin && origin === req.nextUrl.origin);
}

export async function authorize(req: NextRequest) {
  let qa;
  try { qa = readQaRuntime(); } catch { return { error: NextResponse.json({ error: "検証環境は停止中です" }, { status: 503 }) } as const; }
  if (req.method !== "GET" && !sameOrigin(req)) {
    return { error: NextResponse.json({ error: "Forbidden origin" }, { status: 403 }) } as const;
  }
  const claims = verifyToken(req.cookies.get(SESSION_COOKIE)?.value, "session");
  if (!claims) return { error: NextResponse.json({ error: "LINEで再ログインしてください" }, { status: 401 }) } as const;
  if (qa && claims.subject !== qa.ownerLineUserId) return { error: NextResponse.json({ error: "本人専用の検証環境です" }, { status: 403 }) } as const;
  const admin = createSupabaseAdmin();
  if (!admin) return { error: NextResponse.json({ error: "Server not configured" }, { status: 503 }) } as const;
  const { data: user, error } = await admin.from("users").select("line_user_id,display_name").eq("line_user_id", claims.subject).maybeSingle();
  if (error) return { error: NextResponse.json({ error: "認証の確認に失敗しました" }, { status: 503 }) } as const;
  if (!user) return { error: NextResponse.json({ error: "LINEで再ログインしてください" }, { status: 401 }) } as const;
  return { admin, lineUserId: claims.subject, user, owner: isAdmin(claims.subject) } as const;
}
