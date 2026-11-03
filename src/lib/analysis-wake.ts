import type { SupabaseClient } from "@supabase/supabase-js";
import { runScheduledAnalysisBatch } from "./analysis-scheduled";

type WakeClaim = { permit_id: string; claim_token: string; worker_tick_id: string };

export function wakeEnabled(): boolean {
  return process.env.ANALYSIS_WAKE_ENABLED === "true" && ["disabled", "scheduled-wake"].includes(process.env.ANALYSIS_BACKGROUND_MODE ?? "disabled");
}

/** Private DB authority, never caller-provided IDs, headers, cookies or body. */
export async function claimAnalysisWake(admin: SupabaseClient, origin: string): Promise<WakeClaim | null> {
  const { data, error } = await admin.rpc("claim_analysis_wake", {
    p_origin: origin,
    p_processing_enabled: process.env.ANALYSIS_BACKGROUND_MODE === "scheduled-wake",
  });
  if (error) throw new Error("Wake claim unavailable");
  const claim = Array.isArray(data) ? data[0] : null;
  if (!claim || ![claim.permit_id, claim.claim_token, claim.worker_tick_id].every((v) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v))) return null;
  return claim;
}

/** Only server-held permit/tick IDs enter this function. HTTP responses remain empty. */
export async function runAnalysisWake(admin: SupabaseClient, claim: WakeClaim): Promise<void> {
  try {
    await runScheduledAnalysisBatch(admin, undefined, undefined, claim.worker_tick_id);
    const { data, error } = await admin.rpc("complete_analysis_wake", { p_id: claim.permit_id, p_claim_token: claim.claim_token, p_success: true });
    if (error || data !== true) throw new Error("Wake completion rejected");
  } catch {
    try { await admin.rpc("analysis_worker_tick_complete", { p_tick_id: claim.worker_tick_id, p_success: false }); } catch { /* Readiness expires even if DB is unavailable. */ }
    try { await admin.rpc("complete_analysis_wake", { p_id: claim.permit_id, p_claim_token: claim.claim_token, p_success: false }); } catch { /* Root reconciliation also expires unfinished claims. */ }
    console.error("[analysis-wake] private batch failed");
  }
}
