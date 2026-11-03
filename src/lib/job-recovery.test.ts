import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as discover } from "../app/api/analysis-jobs/route";
import { GET as getJob } from "../app/api/analysis-jobs/[id]/route";
import { POST as seen } from "../app/api/analysis-jobs/[id]/seen/route";
import { signToken, SESSION_COOKIE } from "./session-token";

test("discovery and receipt are owner-scoped; a job uses its own mode and current health", async () => {
  const names = ["SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANALYSIS_BACKGROUND_MODE"];
  const saved = names.map((n) => process.env[n]), savedFetch = global.fetch;
  Object.assign(process.env, { SESSION_SECRET: "synthetic-session-only-0000000000000000", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic", ANALYSIS_BACKGROUND_MODE: "scheduled-wake" });
  const id = "00000000-0000-4000-8000-000000000001", params = { params: { id } }, owner = "synthetic-owner";
  let listFailure = false, jobMode = "scheduled-wake", healthy = true;
  const req = (path: string, method = "GET") => new NextRequest("https://app.example.test" + path, { method, headers: { origin: "https://app.example.test", cookie: `${SESSION_COOKIE}=${signToken("session", owner, 3600)}` } });
  global.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "db.example.test");
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/users")) return json({ line_user_id: owner });
    if (url.pathname.endsWith("/analysis_admission_ready")) return json(healthy);
    assert.ok(url.pathname.endsWith("/analysis_jobs")); assert.equal(url.searchParams.get("line_user_id"), `eq.${owner}`);
    if (init?.method === "PATCH") {
      assert.equal(url.searchParams.get("id"), `eq.${id}`); assert.equal(url.searchParams.get("status"), "in.(done,failed)");
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body), ["client_result_seen_at"]); return json({ id });
    }
    if (url.searchParams.has("id")) return json({ id, status: "running", execution_mode: jobMode, analysis_job_images: [] });
    assert.equal(url.searchParams.get("limit"), "10"); assert.ok(url.searchParams.get("or")?.includes("client_result_seen_at.is.null"));
    assert.ok(url.searchParams.get("select")?.includes("notification_status")); assert.ok(url.searchParams.get("select")?.includes("site_name"));
    return listFailure ? json({ message: "Synthetic outage" }, 503) : json([{ id, status: "running", client_result_seen_at: null }]);
  };
  try {
    let response: Response = await discover(req("/api/analysis-jobs?line_user_id=someone-else")); assert.equal(response.status, 200); assert.equal((await response.json()).data[0].id, id);
    response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, true);
    jobMode = "interactive"; response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, false);
    jobMode = "scheduled-wake"; healthy = false; response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, false);
    assert.equal((await seen(req("/api/analysis-jobs/" + id + "/seen", "POST"), params)).status, 200);
    listFailure = true; assert.equal((await discover(req("/api/analysis-jobs"))).status, 503);
    assert.equal((await discover(new NextRequest("https://app.example.test/api/analysis-jobs"))).status, 401);
  } finally { global.fetch = savedFetch; names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; }); }
});
