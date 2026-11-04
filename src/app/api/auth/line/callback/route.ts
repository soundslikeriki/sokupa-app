import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { isAdmin } from "@/lib/server-auth";
import { INVITE_COOKIE, SESSION_COOKIE, SESSION_SECONDS, secureCookieOptions, signToken, verifyToken } from "@/lib/session-token";
import { lineLoginErrorResponse } from "@/lib/line-login-error";
import { readQaRuntime } from "@/lib/qa-runtime";

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
    const qa = readQaRuntime();
    const url = new URL(req.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (url.searchParams.has("error")) return lineLoginErrorResponse(url.searchParams.get("error")?.toUpperCase() === "ACCESS_DENIED" ? "cancelled" : "provider");
    if (!code || !state) {
      return lineLoginErrorResponse("state");
    }

    const cookieState = req.cookies.get("sokupa_line_state")?.value || "";
    if (!cookieState || cookieState !== state) {
      return lineLoginErrorResponse("state");
    }

    const clientId = getEnv("LINE_LOGIN_CHANNEL_ID");
    const clientSecret = getEnv("LINE_LOGIN_CHANNEL_SECRET");
    const redirectUri = getEnv("LINE_LOGIN_REDIRECT_URI");

    const { access_token } = await exchangeToken({ code, redirectUri, clientId, clientSecret });
    const profile = await fetchProfile(access_token);
    if (qa && profile.userId !== qa.ownerLineUserId) return lineLoginErrorResponse("invite", 403);
    // OAuth may have consumed the remaining TTL. Recheck before saving any profile.
    readQaRuntime();

    const invite = verifyToken(req.cookies.get(INVITE_COOKIE)?.value, "invite");
    const admin = createSupabaseAdmin();
    if (!admin) return lineLoginErrorResponse("configuration", 503);

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
      if (error) return lineLoginErrorResponse("invite", 403);
    } else {
      const { error } = await admin.from("users").upsert({
        line_user_id: profile.userId, display_name: profile.displayName ?? null,
        picture_url: profile.pictureUrl ?? null, last_login_at: new Date().toISOString(),
      }, { onConflict: "line_user_id" });
      if (error) throw new Error("Account update failed");
    }

    const res = NextResponse.redirect(new URL("/", req.url), { status: 302 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.cookies.set(SESSION_COOKIE, signToken("session", profile.userId, SESSION_SECONDS), { ...secureCookieOptions, maxAge: SESSION_SECONDS });
    res.cookies.delete(INVITE_COOKIE);
    res.cookies.delete("sokupa_line_user_id");
    res.cookies.delete("sokupa_display_name");
    res.cookies.delete("sokupa_invited");
    res.cookies.delete("sokupa_line_state");
    res.cookies.delete("sokupa_invite_code");
    return res;
  } catch {
    console.error("[LINE callback] login unavailable");
    return lineLoginErrorResponse("provider", 503);
  }
}

