import type { SupabaseClient } from "@supabase/supabase-js";

export function scheduledAnalysisEnabled(): boolean {
  return ["scheduled", "scheduled-wake"].includes(process.env.ANALYSIS_BACKGROUND_MODE ?? "");
}

/** Require the configured app/DB mode and its readiness checks before reserving quota. */
export async function analysisBackgroundReady(admin: SupabaseClient): Promise<boolean> {
  const mode = process.env.ANALYSIS_BACKGROUND_MODE;
  if (mode !== "scheduled" && mode !== "scheduled-wake") return false;
  const { data, error } = await admin.rpc("analysis_admission_ready", { p_mode: mode });
  return !error && data === true;
}

export async function analysisDataAccessSecure(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.rpc("analysis_processing_secure");
  return !error && data === true;
}
