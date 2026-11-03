import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processAnalysisJobStep } from "./analysisJobProcessor";

test("legacy work remains untouched and cannot trigger image parsing or completion notifications", async () => {
  for (const status of ["queued", "running", "done", "failed"]) {
    let reads = 0, parses = 0;
    const builder = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => { reads++; return { data: { id: "legacy", status, execution_mode: "legacy", line_user_id: "owner", result: { items: [] }, notification_status: "failed", notification_protocol: "line_retry_v1" }, error: null }; },
      update: () => assert.fail("Legacy records must not be modified"),
    };
    const admin = { from: (name: string) => { assert.equal(name, "analysis_jobs"); return builder; }, rpc: () => assert.fail("Legacy work must not claim images"), storage: { from: () => assert.fail("Legacy work must not read image bytes") } } as unknown as SupabaseClient;
    const outcome = await processAnalysisJobStep({ admin, jobId: "legacy", parse: async () => { parses++; return new Response(); } });
    assert.equal(outcome.status, status === "done" ? "done" : "failed");
    assert.equal(reads, 1); assert.equal(parses, 0);
  }
});
