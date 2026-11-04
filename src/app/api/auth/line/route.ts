import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { lineLoginErrorResponse } from "@/lib/line-login-error";
import { readQaRuntime } from "@/lib/qa-runtime";

export const runtime = "nodejs";
export const maxDuration = 60;

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function randomState(): string {
  // 32 chars hex
  return crypto.randomBytes(16).toString("hex");
}

export async function GET(req: NextRequest) {
  try {
    readQaRuntime();
    const clientId = getEnv("LINE_LOGIN_CHANNEL_ID");
    const redirectUri = getEnv("LINE_LOGIN_REDIRECT_URI");

    const callback = new URL(redirectUri);
    if (callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/api/auth/line/callback") throw new Error("Invalid callback URL");
    if (callback.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(callback.hostname))) throw new Error("Invalid callback URL");
    // Set the state cookie on the callback's origin, including when opened through a Vercel alias.
    // Never copy an incoming code/state or an arbitrary return URL into the redirect.
    // Compare the same Next URL normalization on both sides (127.0.0.1 becomes localhost locally).
    if (req.nextUrl.origin !== new NextRequest(callback).nextUrl.origin) {
      const start = new URL("/api/auth/line", callback.origin);
      if (req.nextUrl.searchParams.get("browser") === "1") start.searchParams.set("browser", "1");
      return NextResponse.redirect(start, { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }

    const state = randomState();

    const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "profile openid");
    url.searchParams.set("ui_locales", "ja");
    if (req.nextUrl.searchParams.get("browser") === "1") url.searchParams.set("disable_auto_login", "true");

    const res = NextResponse.redirect(url.toString(), { status: 302 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.cookies.set("sokupa_line_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 10, // 10min
      path: "/",
    });
    return res;
  } catch {
    return lineLoginErrorResponse("configuration", 503);
  }
}

