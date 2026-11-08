import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { analysisBackgroundReady } from "./analysis-background";
import { runScheduledAnalysisBatch } from "./analysis-scheduled";
import { runAnalysisJob } from "./analysisJobProcessor";

// All requests target explicit synthetic responses. No browser and no real API traffic.
test("disabled processing only observes health; stale workers close intake", async () => {
  const saved = process.env.ANALYSIS_BACKGROUND_MODE;
  const calls: string[] = [];
  let healthy = false;
  const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false }, global: { fetch: async (input) => {
    const name = new URL(String(input)).pathname.split("/").pop()!; calls.push(name);
    return new Response(JSON.stringify(name === "analysis_admission_ready" ? healthy : name === "analysis_worker_tick_begin" ? "synthetic-tick" : true), { headers: { "Content-Type": "application/json" } });
  } } });
  try {
    process.env.ANALYSIS_BACKGROUND_MODE = "disabled";
    assert.equal(await analysisBackgroundReady(admin), false);
    assert.deepEqual(await runScheduledAnalysisBatch(admin, async () => { throw new Error("disabled worker processed OCR"); }), { processed: 0, processing_enabled: false });
    assert.deepEqual(calls, ["analysis_worker_tick_begin", "analysis_worker_tick_complete"]);
    process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
    assert.equal(await analysisBackgroundReady(admin), false);
    healthy = true;
    assert.equal(await analysisBackgroundReady(admin), true);
    process.env.ANALYSIS_BACKGROUND_MODE="interactive";
    assert.equal(await analysisBackgroundReady(admin),false);
    assert.deepEqual(await runScheduledAnalysisBatch(admin,async()=>{throw Error('interactive mode ran a scheduled batch');}),{processed:0,processing_enabled:false});
    process.env.ANALYSIS_BACKGROUND_MODE="scheduled-wake";
    assert.equal(await analysisBackgroundReady(admin),true);
  } finally { if (saved === undefined) delete process.env.ANALYSIS_BACKGROUND_MODE; else process.env.ANALYSIS_BACKGROUND_MODE = saved; }
});

test("independent scheduled ticks finish two 31-second images after the browser is gone", async () => {
  const savedFetch = global.fetch, savedNow = Date.now;
  const names = ["ANALYSIS_BACKGROUND_MODE", "NEXT_PUBLIC_SUPABASE_URL", "LINE_CHANNEL_ACCESS_TOKEN"];
  const saved = names.map((name) => process.env[name]);
  process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "synthetic-only";
  let clock = Date.now(), parseCalls = 0, sends = 0, heartbeats = 0;
  Date.now = () => clock;
  const job: any = { id: "00000000-0000-4000-8000-000000000000", status: "queued", total_images: 2, line_user_id: "synthetic", notification_status: "pending", notification_protocol: "line_retry_v1" };
  const images = [0,1].map((idx) => ({ id: `image-${idx}`, idx, status: "queued", url: `synthetic/${idx}.jpg`, lease_token: `lease-${idx}`, parsed: null as unknown }));
  global.fetch = async (input, init) => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (url.hostname === "api.line.me") { sends++; return json({}); }
    if (url.pathname.includes("/storage/")) return new Response(new Uint8Array([255,216,255,217]), { headers: { "Content-Type": "image/jpeg" } });
    if (url.hostname !== "db.example.test") throw new Error("Unexpected external request");
    const name = url.pathname.split("/").pop();
    if (name === "analysis_worker_tick_begin") { heartbeats++; return json("synthetic-tick"); }
    if (name === "analysis_worker_tick_complete") { assert.equal(body.p_success, true); assert.equal(body.p_tick_id, "synthetic-tick"); return json(true); }
    if (name === "analysis_processing_secure") return json(true);
    if (name === "resumable_analysis_jobs") return json(job.status === "done" ? [] : [{ id: job.id }]);
    if (name === "claim_durable_analysis_image") { const image = images.find((item) => item.status === "queued"); if (!image) return json([]); image.status = "running"; job.status = "running"; return json([{ ...image }]); }
    if (name === "complete_analysis_image") { const image = images.find((item) => item.id === body.p_image_id)!; assert.equal(image.lease_token, body.p_lease_token); image.status = "done"; image.parsed = body.p_parsed; return json(true); }
    if (name === "analysis_jobs") { if (init?.method === "PATCH") Object.assign(job, body); return json({ ...job }); }
    if (name === "analysis_job_images") return json(images.map((image) => ({ ...image })));
    throw new Error(`Unexpected call: ${name}`);
  };
  try {
    const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false } });
    const run = (opts: Parameters<typeof runAnalysisJob>[0]) => runAnalysisJob({ ...opts, parse: async () => {
      parseCalls++; clock += 31_000;
      return new Response(JSON.stringify({ data: { items: [{ product_code: "VS2067", manufacturer: "Test", entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }], total_m: 20, order_quantity: 23 }] } }));
    } });
    await runScheduledAnalysisBatch(admin, run);
    assert.equal(images[0].status, "done"); assert.equal(images[1].status, "queued");
    clock += 60_000; // The independent scheduler triggers the next invocation; no UI request occurs.
    await runScheduledAnalysisBatch(admin, run);
    assert.equal(job.status, "done"); assert.equal(job.result.items[0].total_m, 40);
    assert.equal(job.notification_status, "accepted"); assert.equal(parseCalls, 2); assert.equal(sends, 1); assert.equal(heartbeats, 2);
  } finally { global.fetch = savedFetch; Date.now = savedNow; names.forEach((name,index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});

test("failed scheduled batch waits for other claimed work and records an unhealthy heartbeat", async () => {
  const saved = process.env.ANALYSIS_BACKGROUND_MODE;
  process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
  const finished: boolean[] = [];
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const name = new URL(String(input)).pathname.split("/").pop();
    if (name === "analysis_worker_tick_complete") finished.push(JSON.parse(String(init?.body)).p_success);
    return new Response(JSON.stringify(name === "analysis_processing_secure" ? true : name === "resumable_analysis_jobs" ? [{ id: "fail" }, { id: "pause" }] : name === "analysis_worker_tick_begin" ? "synthetic-tick" : true), { headers: { "Content-Type": "application/json" } });
  } } });
  try {
    const promise = runScheduledAnalysisBatch(admin, async ({jobId}) => { if (jobId === "fail") throw new Error("synthetic failure"); enter(); await paused; return { status: "done" }; });
    const rejected = assert.rejects(promise, /Scheduled processing incomplete/);
    await entered; assert.deepEqual(finished, []); release(); await rejected;
    assert.deepEqual(finished, [false]);
  } finally { release(); if (saved === undefined) delete process.env.ANALYSIS_BACKGROUND_MODE; else process.env.ANALYSIS_BACKGROUND_MODE = saved; }
});

test("DB job fetch failure is an unhealthy scheduled invocation, regardless of failed job status", async () => {
  const saved = process.env.ANALYSIS_BACKGROUND_MODE;
  process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
  const outcomes: boolean[] = [];
  const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const name = new URL(String(input)).pathname.split("/").pop();
    if (name === "analysis_worker_tick_complete") { const body = JSON.parse(String(init?.body)); assert.equal(body.p_tick_id, "synthetic-tick"); outcomes.push(body.p_success); }
    if (name === "analysis_jobs") return new Response(JSON.stringify({ message: "Synthetic DB unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
    const data = name === "analysis_worker_tick_begin" ? "synthetic-tick" : name === "resumable_analysis_jobs" ? [{ id: "synthetic-job" }] : true;
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  } } });
  try {
    await assert.rejects(runScheduledAnalysisBatch(admin), /Scheduled processing incomplete/);
    assert.deepEqual(outcomes, [false]);
  } finally { if (saved === undefined) delete process.env.ANALYSIS_BACKGROUND_MODE; else process.env.ANALYSIS_BACKGROUND_MODE = saved; }
});

test("persisted image failure completes a healthy tick; infrastructure errors in every status do not", async () => {
  const saved = process.env.ANALYSIS_BACKGROUND_MODE;
  process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
  const outcomes: boolean[] = [];
  const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const name = new URL(String(input)).pathname.split("/").pop();
    if (name === "analysis_worker_tick_complete") outcomes.push(JSON.parse(String(init?.body)).p_success);
    const data = name === "analysis_worker_tick_begin" ? "synthetic-tick" : name === "resumable_analysis_jobs" ? [{ id: "synthetic-job" }] : true;
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  } } });
  try {
    await runScheduledAnalysisBatch(admin, async () => ({ status: "failed", error: "Unreadable image", failureKind: "job" }));
    assert.deepEqual(outcomes, [true]);
    for (const status of ["running", "failed", "done"] as const) {
      await assert.rejects(runScheduledAnalysisBatch(admin, async () => ({ status, error: "Synthetic infrastructure failure", failureKind: "infrastructure" })), /Scheduled processing incomplete/);
    }
    assert.deepEqual(outcomes, [true, false, false, false]);
  } finally { if (saved === undefined) delete process.env.ANALYSIS_BACKGROUND_MODE; else process.env.ANALYSIS_BACKGROUND_MODE = saved; }
});
