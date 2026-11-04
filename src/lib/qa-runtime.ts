import { createHash } from "node:crypto";

/** Server-only, deliberately independent of request input. No provider mock may fall through. */
export class QaRuntimeError extends Error {
  constructor() { super("検証環境は停止中です。設定または有効期限を確認してください。"); }
}
export type QaBinding = {
  version: 1; projectId: string; dbRef: string; ownerLineUserId: string;
  lineLoginChannelId: string; origin: string; issuedAt: number; expiresAt: number;
  serviceKeySha256: string; sessionSecretSha256: string; lineSecretSha256: string;
};
const PRODUCTION_PROJECT = "prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx";
const PRODUCTION_REF = "yegdgginwcmvpzeiuags";
const PRODUCTION_CHANNEL = "2009808783";
export const qaHash = (value: string) => createHash("sha256").update(value).digest("hex");

export function readQaRuntime(env: Readonly<Record<string,string | undefined>> = process.env, now = Date.now()): QaBinding | null {
  if (!env.SOKUPA_QA_MODE && !env.SOKUPA_QA_BINDING) return null;
  const fail = () => { throw new QaRuntimeError(); };
  if (env.SOKUPA_QA_MODE !== "synthetic-owner-v1" || !env.SOKUPA_QA_BINDING) return fail();
  let q: QaBinding;
  try { q = JSON.parse(env.SOKUPA_QA_BINDING); } catch { return fail(); }
  if (!q || q.version !== 1 || !/^prj_[A-Za-z0-9]+$/.test(q.projectId) || q.projectId === PRODUCTION_PROJECT ||
      !/^[a-z]{20}$/.test(q.dbRef) || q.dbRef === PRODUCTION_REF || !/^U[a-f0-9]{32}$/.test(q.ownerLineUserId) ||
      !/^\d{8,16}$/.test(q.lineLoginChannelId) || q.lineLoginChannelId === PRODUCTION_CHANNEL ||
      !Number.isSafeInteger(q.issuedAt) || !Number.isSafeInteger(q.expiresAt) || q.issuedAt > now ||
      q.expiresAt <= now || q.expiresAt <= q.issuedAt || q.expiresAt - q.issuedAt > 90 * 60_000) return fail();
  let origin: URL;
  try { origin = new URL(q.origin); } catch { return fail(); }
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".vercel.app") || origin.origin !== q.origin ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      env.VERCEL_PROJECT_ID !== q.projectId || env.NEXT_PUBLIC_SUPABASE_URL !== `https://${q.dbRef}.supabase.co` ||
      env.ADMIN_LINE_USER_ID !== q.ownerLineUserId || env.LINE_LOGIN_CHANNEL_ID !== q.lineLoginChannelId ||
      env.LINE_LOGIN_REDIRECT_URI !== `${q.origin}/api/auth/line/callback`) return fail();
  for (const [name, hash] of [["SUPABASE_SERVICE_ROLE_KEY", q.serviceKeySha256], ["SESSION_SECRET", q.sessionSecretSha256], ["LINE_LOGIN_CHANNEL_SECRET", q.lineSecretSha256]]) {
    const value = env[name];
    if (!value || !/^[a-f0-9]{64}$/.test(hash) || qaHash(value) !== hash) return fail();
  }
  if (Buffer.byteLength(env.SESSION_SECRET!) < 32 ||
      ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "LINE_CHANNEL_ACCESS_TOKEN"].some(name => env[name]?.trim())) return fail();
  // Legacy JWT service keys carry the project ref. Opaque new keys are bound by their SHA256 above.
  const parts = env.SUPABASE_SERVICE_ROLE_KEY!.split(".");
  if (parts.length === 3) {
    try { const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); if (claims.ref && claims.ref !== q.dbRef) return fail(); }
    catch { return fail(); }
  }
  return q;
}

export function qaSummary(q: QaBinding | null) {
  return q ? { synthetic: true, expires_at: new Date(q.expiresAt).toISOString() } : null;
}

export async function syntheticQaVision(q: QaBinding, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  await wait(31_000);
  const current = readQaRuntime();
  if (!current || current.projectId !== q.projectId || current.expiresAt !== q.expiresAt) throw new QaRuntimeError();
  return JSON.stringify({ items: [{ product_code: "QA2067", manufacturer: "合成試験", confidence: 1,
    entries: [{ original_formula: "20×1", length_m: 20, quantity: 1 }] }], notes: "QA合成結果：画像内容は解析していません" });
}
