import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readQaRuntime } from "./qa-runtime";

/**
 * サーバー専用。RLS をバイパスするため、ユーザーデータ操作は必ず認証と所有者チェックの後に行う。
 */
export function createSupabaseAdmin(): SupabaseClient | null {
  try { readQaRuntime(); } catch { return null; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
