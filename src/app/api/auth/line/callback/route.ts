import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isAdmin } from "@/lib/server-auth";
import { INVITE_COOKIE, SESSION_COOKIE, SESSION_SECONDS, secureCookieOptions, signToken, verifyToken } from "@/lib/session-token";

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
      return NextResponse.json({ error: "ログインの確認ができませんでした。元のブラウザから再度ログインしてください。" }, { status: 400 });
    }

    const clientId = getEnv("LINE_LOGIN_CHANNEL_ID");
    const clientSecret = getEnv("LINE_LOGIN_CHANNEL_SECRET");
    const redirectUri = getEnv("LINE_LOGIN_REDIRECT_URI");

    const { access_token } = await exchangeToken({ code, redirectUri, clientId, clientSecret });
    const profile = await fetchProfile(access_token);

    const invite = verifyToken(req.cookies.get(INVITE_COOKIE)?.value, "invite");
    const admin = createSupabaseAdmin();
    if (!admin) return NextResponse.json({ error: "Server not configured" }, { status: 503 });

    // Existing accounts are grandfathered even when their historic invite_code is null.
    const { data: existing, error: lookupError } = await admin.from("users").select("line_user_id").eq("line_user_id", profile.userId).maybeSingle();
    if (lookupError) throw new Error("Account lookup failed");
    const { data: unlimited, error: unlimitedError } = await admin.from("unlimited_users").select("id").eq("line_user_id", profile.userId).maybeSingle();
    if (unlimitedError) throw new Error("Account lookup failed");
    if (!existing && !unlimited && !isAdmin(profile.userId)) {
      if (!invite) return NextResponse.redirect(new URL("/?auth_error=invite_required", req.url));
      const { error } = await admin.rpc("register_invited_line_user", {
        p_line_user_id: profile.userId, p_display_name: profile.displayName ?? null,
        p_picture_url: profile.pictureUrl ?? null, p_invite_code: invite.subject,
      });
      if (error) return NextResponse.json({ error: "招待コードの登録に失敗しました。コードを確認してください。" }, { status: 403 });
    } else {
      const { error } = await admin.from("users").upsert({
        line_user_id: profile.userId, display_name: profile.displayName ?? null,
        picture_url: profile.pictureUrl ?? null, last_login_at: new Date().toISOString(),
      }, { onConflict: "line_user_id" });
      if (error) throw new Error("Account update failed");
    }

    const res = NextResponse.redirect(new URL("/", req.url), { status: 302 });
    res.cookies.set(SESSION_COOKIE, signToken("session", profile.userId, SESSION_SECONDS), { ...secureCookieOptions, maxAge: SESSION_SECONDS });
    res.cookies.delete(INVITE_COOKIE);
    res.cookies.delete("sokupa_line_user_id");
    res.cookies.delete("sokupa_display_name");
    res.cookies.delete("sokupa_invited");
    res.cookies.delete("sokupa_line_state");
    res.cookies.delete("sokupa_invite_code");
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

