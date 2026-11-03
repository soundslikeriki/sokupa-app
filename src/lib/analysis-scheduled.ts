import type { SupabaseClient } from "@supabase/supabase-js";
import { runAnalysisJob, type AnalysisJobStepResult } from "@/lib/analysisJobProcessor";
import { scheduledAnalysisEnabled, analysisDataAccessSecure } from "@/lib/analysis-background";

/** Completion is awaited by the scheduled HTTP request, independently of the browser. */
export async function runScheduledAnalysisBatch(
  admin: SupabaseClient,
  run: (opts: Parameters<typeof runAnalysisJob>[0]) => Promise<AnalysisJobStepResult> = runAnalysisJob,
  dispatchId?: string,
  claimedTickId?: string,
): Promise<{ processed: number; processing_enabled: boolean; worker_tick_id?: string }> {
  const started = claimedTickId ? { data: claimedTickId, error: null } : dispatchId ? await admin.rpc("begin_signed_analysis_worker_tick",{p_dispatch_id:dispatchId}) : await admin.rpc("analysis_worker_tick_begin");
  if (started.error || typeof started.data !== "string" || !started.data) throw new Error("Worker heartbeat failed");
  const tickId = started.data;
  try {
    let processed = 0;
    if (scheduledAnalysisEnabled()) {
      if (!(await analysisDataAccessSecure(admin))) throw new Error("Private data access not secured");
      const { data, error } = await admin.rpc("resumable_analysis_jobs");
      if (error) throw new Error("Recovery lookup failed");
      const outcomes = await Promise.allSettled((data ?? []).map((job: { id: string }) => run({ admin, jobId: job.id })));
      if (outcomes.some((outcome) => outcome.status === "rejected" || outcome.value.failureKind === "infrastructure" || (outcome.value.status === "running" && outcome.value.error))) throw new Error("Scheduled processing incomplete");
      processed = data?.length ?? 0;
    }
    const finished = await admin.rpc("analysis_worker_tick_complete", { p_tick_id: tickId, p_success: true });
    if (finished.error || finished.data !== true) throw new Error("Worker completion heartbeat failed");
    return { processed, processing_enabled: scheduledAnalysisEnabled(),...(dispatchId?{worker_tick_id:tickId}:{}) };
  } catch (error) {
    await admin.rpc("analysis_worker_tick_complete", { p_tick_id: tickId, p_success: false });
    throw error;
  }
}
