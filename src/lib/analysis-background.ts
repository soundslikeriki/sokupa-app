import type { SupabaseClient } from "@supabase/supabase-js";

export function scheduledAnalysisEnabled(): boolean {
  return process.env.ANALYSIS_BACKGROUND_MODE === "scheduled";
}

/** Never accept work that depends on an unconfigured/stale caller. No quota is reserved here. */
export async function analysisBackgroundReady(admin: SupabaseClient): Promise<boolean> {
  if (!scheduledAnalysisEnabled()) return false;
  const { data, error } = await admin.rpc("analysis_background_ready");
  return !error && data === true;
}


export async function analysisDataAccessSecure(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.rpc("analysis_processing_secure");
  return !error && data === true;
}
