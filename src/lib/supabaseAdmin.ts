import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * サーバー専用。RLS をバイパスしてキャッシュテーブル等に書き込む用途のみ使用すること。
 */
export function createSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
