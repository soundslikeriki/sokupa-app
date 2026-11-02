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
    const value = url.pathname.endsWith("/analysis_jobs") ? { id: "fake-job", status: "running", total_images: 1 } : url.searchParams.get("select") === "id,idx,url,status" ? null : [{ status: "running" }];
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  } } });
  assert.equal((await processAnalysisJobStep({ admin, jobId: "fake-job" })).status, "running");
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
});
