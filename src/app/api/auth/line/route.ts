import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

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
    const clientId = getEnv("LINE_LOGIN_CHANNEL_ID");
    const redirectUri = getEnv("LINE_LOGIN_REDIRECT_URI");

    const state = randomState();

    const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "profile openid");

    const res = NextResponse.redirect(url.toString(), { status: 302 });
    res.cookies.set("sokupa_line_state", state, {
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

