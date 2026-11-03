import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../app/api/analysis-jobs/wake/route";

test("public wake responses reveal nothing; only private permits start a batch", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const names = ["ANALYSIS_WAKE_ENABLED", "ANALYSIS_BACKGROUND_MODE", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((n) => process.env[n]), savedFetch = global.fetch;
  const symbol = Symbol.for("@vercel/request-context"), context = globalThis as unknown as Record<symbol, unknown>, savedContext = context[symbol];
  const tasks: Promise<unknown>[] = [], calls: { name: string; body: Record<string, unknown> }[] = [];
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  let permitted = false, infrastructureFailure = false, claimFailure = false;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-only";
    process.env.ANALYSIS_WAKE_ENABLED = "false"; process.env.ANALYSIS_BACKGROUND_MODE = "scheduled-wake";
    context[symbol] = { get: () => ({ waitUntil: (p: Promise<unknown>) => tasks.push(p) }) };
    global.fetch = async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.hostname, "db.example.test");
      const name = url.pathname.split("/").pop()!, body = JSON.parse(String(init?.body ?? "{}")); calls.push({ name, body });
      if ((name === "resumable_analysis_jobs" && infrastructureFailure) || (name === "claim_analysis_wake" && claimFailure)) return new Response(JSON.stringify({ message: "Synthetic outage" }), { status: 503, headers: { "Content-Type": "application/json" } });
      const data = name === "claim_analysis_wake" ? permitted ? [{ permit_id: ids[0], claim_token: ids[1], worker_tick_id: ids[2] }] : [] : name === "resumable_analysis_jobs" ? [] : true;
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    };
    const signal = async (suffix = "") => {
      now += 5_001;
      const response = await POST(new NextRequest("https://worker.example.test/api/analysis-jobs/wake" + suffix, { method: "POST", headers: { "x-sokupa-dispatch-id": "attacker-id" }, body: JSON.stringify({ job_id: "other-user-job", permit_id: "forged", claim_token: "forged" }) }));
      assert.equal(response.status, 204); assert.equal(await response.text(), ""); assert.equal(response.headers.get("cache-control"), "no-store");
    };
    await signal(); assert.equal(calls.length, 0); assert.equal(tasks.length, 0);
    process.env.ANALYSIS_WAKE_ENABLED = "true";
    await signal("?permit_id=forged"); assert.equal(calls.length, 0);
    await signal(); assert.equal(calls.length, 1); assert.equal(tasks.length, 0);
    assert.deepEqual(calls[0], { name: "claim_analysis_wake", body: { p_origin: "https://worker.example.test", p_processing_enabled: true } });
    calls.length = 0; permitted = true;
    await signal(); assert.equal(tasks.length, 1); await Promise.all(tasks.splice(0));
    assert.deepEqual(calls.map((x) => x.name), ["claim_analysis_wake", "analysis_processing_secure", "resumable_analysis_jobs", "analysis_worker_tick_complete", "complete_analysis_wake"]);
    assert.deepEqual(calls.at(-1)?.body, { p_id: ids[0], p_claim_token: ids[1], p_success: true });
    assert.equal(calls.some((x) => x.name === "analysis_worker_tick_begin"), false);
    calls.length = 0; infrastructureFailure = true;
    await signal(); await Promise.all(tasks.splice(0));
    assert.equal(calls.at(-1)?.body.p_success, false);
    assert.equal(calls.some((x) => x.name === "analysis_worker_tick_complete" && x.body.p_success === false), true);
    calls.length = 0; claimFailure = true;
    await signal(); assert.equal(tasks.length, 0); assert.deepEqual(calls.map((x) => x.name), ["claim_analysis_wake"]);
    calls.length = 0; claimFailure = false; permitted = false;
    now += 5_001;
    await Promise.all(Array.from({ length: 100 }, () => POST(new NextRequest("https://worker.example.test/api/analysis-jobs/wake", { method: "POST" }))));
    assert.deepEqual(calls.map((x) => x.name), ["claim_analysis_wake"]);
  } finally {
    await Promise.allSettled(tasks); global.fetch = savedFetch; context[symbol] = savedContext;
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
  }
});
