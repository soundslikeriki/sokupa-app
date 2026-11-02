import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "sokupa_session";
export const INVITE_COOKIE = "sokupa_invite_proof";
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
type Claims = { purpose: "session" | "invite"; subject: string; expires: number };

function secret(): string {
  const value = process.env.SESSION_SECRET?.trim();
  if (!value || Buffer.byteLength(value) < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes");
  return value;
}

export function signToken(purpose: Claims["purpose"], subject: string, seconds: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ purpose, subject, expires: Math.floor(now / 1000) + seconds })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyToken(token: string | undefined, purpose: Claims["purpose"], now = Date.now()): Claims | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
    if (claims.purpose !== purpose || typeof claims.subject !== "string" || !claims.subject ||
        !Number.isSafeInteger(claims.expires) || claims.expires <= Math.floor(now / 1000)) return null;
    return claims;
  } catch { return null; }
}

export const secureCookieOptions = {
  httpOnly: true, sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production", path: "/",
};
