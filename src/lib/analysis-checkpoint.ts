import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AnalysisCheckpointError } from "./analysis-budget";
import type { MemoCheckpoint } from "./parseMemo";

/** A failed write response is reconciled, never interpreted as permission to resend AI. */
export async function imageJournal(admin: SupabaseClient, id: string, lease: string) {
  const read = async () => {
    const { data, error } = await admin.from("analysis_job_images").select("pipeline_checkpoint,provider_operation,lease_token,status").eq("id", id).maybeSingle();
    if (error || !data || data.lease_token !== lease || data.status !== "running") throw new AnalysisCheckpointError();
    return data;
  };
  const initial = await read();
  if (initial.provider_operation) throw new AnalysisCheckpointError();
  let checkpoint = initial.pipeline_checkpoint as (MemoCheckpoint & { revision: string }) | null;
  let operation: string | null = null;
  return {
    checkpoint,
    async beforeProvider(stage: string) {
      const next = randomUUID();
      const { data, error } = await admin.rpc("begin_analysis_provider", { p_image_id: id, p_lease_token: lease, p_operation: next, p_stage: stage, p_revision: checkpoint?.revision ?? null });
      if (error || data !== true) {
        const observed = await read();
        if (observed.provider_operation !== next) throw new AnalysisCheckpointError();
      }
      operation = next;
    },
    async save(value: MemoCheckpoint) {
      const next = { ...value, revision: randomUUID() };
      const { data, error } = await admin.rpc("checkpoint_analysis_image", { p_image_id: id, p_lease_token: lease, p_operation: operation, p_checkpoint: next });
      if (error || data !== true) {
        const observed = await read();
        if (observed.provider_operation !== null || observed.pipeline_checkpoint?.revision !== next.revision) throw new AnalysisCheckpointError();
      }
      checkpoint = next;
      operation = null;
    },
  };
}
