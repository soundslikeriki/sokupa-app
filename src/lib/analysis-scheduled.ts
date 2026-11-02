import type { SupabaseClient } from "@supabase/supabase-js";
import { runAnalysisJob } from "@/lib/analysisJobProcessor";
import { scheduledAnalysisEnabled, analysisDataAccessSecure } from "@/lib/analysis-background";

/** Completion is awaited by the scheduled HTTP request, independently of the browser. */
export async function runScheduledAnalysisBatch(
  admin: SupabaseClient,
  run: (opts: Parameters<typeof runAnalysisJob>[0]) => Promise<unknown> = runAnalysisJob,
): Promise<{ processed: number; processing_enabled: boolean }> {
  const started = await admin.rpc("analysis_worker_tick_start");
  if (started.error) throw new Error("Worker heartbeat failed");
  try {
    let processed = 0;
    if (scheduledAnalysisEnabled()) {
      if (!(await analysisDataAccessSecure(admin))) throw new Error("Private data access not secured");
      const { data, error } = await admin.rpc("resumable_analysis_jobs");
      if (error) throw new Error("Recovery lookup failed");
      const outcomes = await Promise.allSettled((data ?? []).map((job: { id: string }) => run({ admin, jobId: job.id })));
      if (outcomes.some((outcome) => outcome.status === "rejected" || (outcome.value && typeof outcome.value === "object" && "status" in outcome.value && outcome.value.status === "running" && "error" in outcome.value && outcome.value.error))) throw new Error("Scheduled processing incomplete");
      processed = data?.length ?? 0;
    }
    const finished = await admin.rpc("analysis_worker_tick_finish", { p_success: true });
    if (finished.error) throw new Error("Worker completion heartbeat failed");
    return { processed, processing_enabled: scheduledAnalysisEnabled() };
  } catch (error) {
    await admin.rpc("analysis_worker_tick_finish", { p_success: false });
    throw error;
  }
}
