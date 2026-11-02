import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { processAnalysisJobStep } from "./analysisJobProcessor";

test("worker persists a complete merged result before notifying; LINE failure keeps analysis done", async () => {
  const savedFetch = global.fetch;
  const savedToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-only-token";
  const updates: any[] = [];
  let notified = false;
  const item = (subtotal: number) => ({ product_code: "VS2067", manufacturer: "Test", entries: [{ original_formula: `${subtotal}×1`, length_m: subtotal, quantity: 1, subtotal_m: subtotal }], total_m: 999, order_quantity: 999 });
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.hostname === "api.line.me") {
      assert.ok(updates.some((update) => update.status === "done" && update.result.items[0].total_m === 26));
      notified = true;
      return new Response(null, { status: 401 });
    }
    if (url.pathname.endsWith("/rpc/claim_analysis_image")) return json([]);
    if (init?.method === "PATCH") {
      updates.push(JSON.parse(String(init.body)));
      return json({ id: "00000000-0000-4000-8000-000000000000" });
    }
    if (url.pathname.endsWith("/analysis_jobs")) return json({ id: "00000000-0000-4000-8000-000000000000", status: "running", line_user_id: "fake-owner", total_images: 2, context: {} });
    if (url.searchParams.get("select") === "id,idx,url,status") return json(null);
    return json([{ idx: 0, status: "done", parsed: { items: [item(20)] } }, { idx: 1, status: "done", parsed: { items: [item(6)] } }]);
  };
  try {
    const admin = createClient("https://db.example.test", "test-only-key", { auth: { persistSession: false } });
    const result = await processAnalysisJobStep({ admin, jobId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(result.status, "done");
    assert.equal(notified, true);
    assert.ok(updates.some((update) => update.notification_status === "failed"));
    assert.equal(updates.some((update) => update.status === "failed"), false);
  } finally { global.fetch = savedFetch; if (savedToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = savedToken; }
});

test("worker does not finalize while another image is running", async () => {
  const calls: string[] = [];
  const admin = createClient("https://db.example.test", "test-only-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push(init?.method || "GET");
    const value = url.pathname.endsWith("/analysis_jobs") ? { id: "fake-job", status: "running", total_images: 1 } : url.pathname.endsWith("/rpc/claim_analysis_image") ? [] : [{ status: "running" }];
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  } } });
  assert.equal((await processAnalysisJobStep({ admin, jobId: "fake-job" })).status, "running");
  assert.deepEqual(calls, ["GET", "POST", "GET", "GET"]);
});

test("unproven old pending completion is quarantined without sending LINE", async () => {
  const updates: any[] = [];
  const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "db.example.test");
    const value = init?.method === "PATCH" ? (updates.push(JSON.parse(String(init.body))), null) : { id: "synthetic", status: "done", notification_status: "pending", notification_protocol: "legacy_unknown", result: { items: [] } };
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  } } });
  assert.equal((await processAnalysisJobStep({ admin, jobId: "synthetic" })).status, "done");
  assert.equal(updates[0].notification_status, "legacy_unknown");
});


test("expired lease resumes once, fences a late worker, and never duplicates the completion notification", async () => {
  const savedFetch = global.fetch;
  const savedToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "synthetic-token";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  const job: any = { id: "00000000-0000-4000-8000-000000000000", status: "running", line_user_id: "synthetic", total_images: 1, notification_status: "pending" };
  const image: any = { id: "image", idx: 0, url: "synthetic/00000000-0000-4000-8000-000000000000.jpg", status: "queued", parsed: null };
  let token = 0, expired = false, parseCalls = 0, notifications = 0;
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname === "api.line.me") { notifications++; assert.equal(body.messages.length, 1); return json({}); }
    if (url.pathname.includes("/storage/")) return new Response(new Uint8Array([255,216,255,217]), { headers: { "Content-Type": "image/jpeg" } });
    if (url.pathname.endsWith("/claim_analysis_image")) {
      if (image.status === "done" || (image.status === "running" && !expired)) return json([]);
      image.status = "running"; image.lease_token = `lease-${++token}`; expired = false;
      return json([{ ...image }]);
    }
    if (url.pathname.endsWith("/complete_analysis_image")) {
      if (body.p_lease_token !== image.lease_token || image.status !== "running" || expired) return json(false);
      image.status = "done"; image.parsed = body.p_parsed; return json(true);
    }
    if (url.pathname.endsWith("/fail_analysis_image")) throw new Error("stale worker must not fail the new result");
    if (url.pathname.endsWith("/analysis_jobs")) {
      if (init?.method === "PATCH") Object.assign(job, body);
      return json({ ...job });
    }
    if (url.pathname.endsWith("/analysis_job_images")) return json([{ ...image }]);
    throw new Error("Unexpected external request");
  };
  const payload = (meters: number) => new Response(JSON.stringify({ data: { image_needs_review: true, items: [{ product_code: "VS2067", manufacturer: "Test", entries: [{ original_formula: `${meters}×1`, length_m: meters, quantity: 1, subtotal_m: meters }], total_m: meters, order_quantity: meters }] } }));
  let enter!: () => void, release!: (value: Response) => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<Response>((resolve) => { release = resolve; });
  try {
    const admin = createClient("https://db.example.test", "synthetic-key", { auth: { persistSession: false } });
    const first = processAnalysisJobStep({ admin, jobId: job.id, parse: async () => { parseCalls++; enter(); return paused; } });
    await entered;
    assert.equal((await processAnalysisJobStep({ admin, jobId: job.id, parse: async () => { throw new Error("active lease duplicated OCR"); } })).status, "running");
    assert.equal(parseCalls, 1);
    expired = true;
    assert.equal((await processAnalysisJobStep({ admin, jobId: job.id, parse: async () => { parseCalls++; return payload(20); } })).status, "done");
    release(payload(100));
    await first;
    assert.equal(job.result.items[0].total_m, 20);
    assert.equal(job.result.needs_review_any, true);
    assert.equal(job.notification_status, "accepted");
    assert.equal((await processAnalysisJobStep({ admin, jobId: job.id })).status, "done");
    assert.equal(notifications, 1);
    assert.equal(parseCalls, 2);
  } finally {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = savedToken;
    if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
  }
});
