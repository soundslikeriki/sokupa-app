import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

async function exchangeToken(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string }> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", params.code);
  body.set("redirect_uri", params.redirectUri);
  body.set("client_id", params.clientId);
  body.set("client_secret", params.clientSecret);

  const res = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(`LINE token API failed: ${res.status} ${String(json?.error_description || json?.error || "")}`.trim());
  }
  const accessToken = String(json?.access_token || "");
  if (!accessToken) throw new Error("No access_token returned from LINE");
  return { access_token: accessToken };
}

async function fetchProfile(accessToken: string): Promise<{ userId: string; displayName?: string; pictureUrl?: string }> {
  const res = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`LINE profile API failed: ${res.status}`);
  const userId = String(json?.userId || "");
  if (!userId) throw new Error("No userId returned from LINE");
  return {
    userId,
    displayName: typeof json?.displayName === "string" ? json.displayName : undefined,
    pictureUrl: typeof json?.pictureUrl === "string" ? json.pictureUrl : undefined,
  };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!code || !state) {
      return NextResponse.json({ error: "Missing code/state" }, { status: 400 });
    }

    const cookieState = req.cookies.get("sokupa_line_state")?.value || "";
    if (!cookieState || cookieState !== state) {
      return NextResponse.json({ error: "Invalid state" }, { status: 401 });
    }

    const clientId = getEnv("LINE_LOGIN_CHANNEL_ID");
    const clientSecret = getEnv("LINE_LOGIN_CHANNEL_SECRET");
    const redirectUri = getEnv("LINE_LOGIN_REDIRECT_URI");

    const { access_token } = await exchangeToken({ code, redirectUri, clientId, clientSecret });
    const profile = await fetchProfile(access_token);

    const inviteCode = req.cookies.get("sokupa_invite_code")?.value || null;

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

    const now = new Date().toISOString();
    const { error: upErr } = await admin.from("users").upsert(
      {
        line_user_id: profile.userId,
        display_name: profile.displayName ?? null,
        picture_url: profile.pictureUrl ?? null,
        invite_code: inviteCode,
        last_login_at: now,
      },
      { onConflict: "line_user_id" },
    );
    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    // localStorage保存のためクエリに乗せて / へ戻す
    const home = new URL("/", req.url);
    home.searchParams.set("line_user_id", profile.userId);
    if (profile.displayName) home.searchParams.set("display_name", profile.displayName);

    const res = NextResponse.redirect(home.toString(), { status: 302 });
    res.cookies.delete("sokupa_line_state");
    res.cookies.delete("sokupa_invite_code");
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

