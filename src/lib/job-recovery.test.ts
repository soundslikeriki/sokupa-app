import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as discover } from "../app/api/analysis-jobs/route";
import { GET as getJob } from "../app/api/analysis-jobs/[id]/route";
import { POST as resume } from "../app/api/analysis-jobs/[id]/resume/route";
import { POST as seen } from "../app/api/analysis-jobs/[id]/seen/route";
import { signToken, SESSION_COOKIE } from "./session-token";

test("discovery and receipt are owner-scoped; a job uses its own mode and current health", async () => {
  const names = ["SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANALYSIS_BACKGROUND_MODE"];
  const saved = names.map((n) => process.env[n]), savedFetch = global.fetch;
  Object.assign(process.env, { SESSION_SECRET: "synthetic-session-only-0000000000000000", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic", ANALYSIS_BACKGROUND_MODE: "scheduled-wake" });
  const id = "00000000-0000-4000-8000-000000000001", params = { params: Promise.resolve({ id }) }, owner = "synthetic-owner";
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
    assert.equal(url.searchParams.get("execution_mode"), "neq.legacy");
    assert.ok(url.searchParams.get("select")?.includes("notification_status")); assert.ok(url.searchParams.get("select")?.includes("site_name"));
    return listFailure ? json({ message: "Synthetic outage" }, 503) : json([{ id, status: "running", client_result_seen_at: null }]);
  };
  try {
    let response: Response = await discover(req("/api/analysis-jobs?line_user_id=someone-else")); assert.equal(response.status, 200); assert.equal((await response.json()).data[0].id, id);
    response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, true);
    jobMode = "interactive"; response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, false);
    jobMode = "scheduled-wake"; healthy = false; response = await getJob(req("/api/analysis-jobs/" + id), params); assert.equal((await response.json()).data.background_ready, false);
    jobMode = "legacy"; response = await getJob(req("/api/analysis-jobs/" + id), params);
    const legacy = (await response.json()).data; assert.equal(legacy.requires_manual_restart, true); assert.equal(legacy.can_resume, false);
    assert.equal((await resume(req("/api/analysis-jobs/" + id + "/resume", "POST"), params)).status, 409);
    jobMode = "scheduled-wake";
    assert.equal((await seen(req("/api/analysis-jobs/" + id + "/seen", "POST"), params)).status, 200);
    listFailure = true; assert.equal((await discover(req("/api/analysis-jobs"))).status, 503);
    assert.equal((await discover(new NextRequest("https://app.example.test/api/analysis-jobs"))).status, 401);
  } finally { global.fetch = savedFetch; names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; }); }
});

test("completed history includes remote-seen accepted jobs and pages only within the authenticated owner", async () => {
  const names = ["SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((name) => process.env[name]), savedFetch = global.fetch;
  Object.assign(process.env, { SESSION_SECRET: "synthetic-session-only-0000000000000000", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic" });
  const owner = "synthetic-owner", stamp = "2026-11-03T00:00:00.123456+00:00";
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(21 - index).padStart(12, "0")}`, site_name: "Synthetic", created_at: stamp, notification_status: "accepted" }));
  const cursor = rows[19].id, foreign = "00000000-0000-4000-8000-000000000099";
  let failed = false, paged = false;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const req = (query = "") => new NextRequest("https://app.example.test/api/analysis-jobs?history=1" + query, { headers: { cookie: `${SESSION_COOKIE}=${signToken("session", owner, 3600)}` } });
  global.fetch = async (input) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "db.example.test");
    if (url.pathname.endsWith("/users")) return json({ line_user_id: owner });
    assert.ok(url.pathname.endsWith("/analysis_jobs")); assert.equal(url.searchParams.get("line_user_id"), `eq.${owner}`);
    assert.equal(url.searchParams.get("status"), "eq.done");
    if (failed) return json({ message: "Synthetic history outage" }, 503);
    if (url.searchParams.has("id")) return json(url.searchParams.get("id") === `eq.${foreign}` ? null : { id: cursor, created_at: stamp });
    assert.equal(url.searchParams.get("limit"), "21"); assert.equal(url.searchParams.get("order"), "created_at.desc,id.desc");
    assert.equal(url.searchParams.get("select"), "id,site_name,created_at,notification_status");
    if (url.searchParams.has("or")) { assert.equal(url.searchParams.get("or"), `(created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${cursor}))`); paged = true; return json([rows[20]]); }
    return json(rows);
  };
  try {
    let response = await discover(req("&line_user_id=someone-else")); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    let payload = await response.json(); assert.equal(payload.data.length, 20); assert.equal(payload.next_before, cursor); assert.equal(payload.data[0].notification_status, "accepted");
    response = await discover(req("&before=" + cursor)); payload = await response.json(); assert.equal(payload.data.length, 1); assert.equal(payload.next_before, null); assert.ok(paged);
    assert.equal((await discover(req("&before=invalid"))).status, 400);
    assert.equal((await discover(req("&before=" + foreign))).status, 404);
    failed = true; assert.equal((await discover(req())).status, 503);
    assert.equal((await discover(new NextRequest("https://app.example.test/api/analysis-jobs?history=1"))).status, 401);
  } finally { global.fetch = savedFetch; names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});
