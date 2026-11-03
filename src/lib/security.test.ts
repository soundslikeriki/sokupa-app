import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { signToken, verifyToken, SESSION_COOKIE } from "./session-token";
import { authorize } from "./server-auth";
import { GET as callback } from "../app/api/auth/line/callback/route";
import { POST as resumeJob } from "../app/api/analysis-jobs/[id]/resume/route";
import { GET as recoverJobs } from "../app/api/analysis-jobs/process/route";
import { GET as getJob } from "../app/api/analysis-jobs/[id]/route";
import { ownedMemoPath, memoObjectPath } from "./memo-storage";
import { POST as createJob } from "../app/api/analysis-jobs/route";
import { GET as workerHealth } from "../app/api/analysis-jobs/worker-health/route";

process.env.SESSION_SECRET = "test-only-fixture-not-a-real-secret-0000";
const origin = "https://app.example.test";

test("signed session rejects tampering, expiration, wrong purpose, raw LINE ID and unsigned cookies", async () => {
  const token = signToken("session", "line-owner", 30, 1_000_000);
  assert.equal(verifyToken(token, "session", 1_001_000)?.subject, "line-owner");
  assert.equal(verifyToken(token, "invite", 1_001_000), null);
  assert.equal(verifyToken(token, "session", 1_031_000), null);
  assert.equal(verifyToken(token + "x", "session", 1_001_000), null);
  assert.equal(verifyToken("line-owner", "session"), null);
  const response = await authorize(new NextRequest(`${origin}/api/admin/generate-invite`, { method: "POST", headers: { origin, cookie: "sokupa_line_user_id=line-owner", authorization: "Bearer line-owner" } }));
  assert.equal(response.error?.status, 401);
});

test("cross-origin mutation is rejected even with a valid signed cookie", async () => {
  const token = signToken("session", "line-owner", 30);
  const response = await authorize(new NextRequest(`${origin}/api/analysis-jobs`, { method: "POST", headers: { origin: "https://attacker.test", cookie: `${SESSION_COOKIE}=${token}` } }));
  assert.equal(response.error?.status, 403);
});

test("LINE callback refuses missing and mismatched OAuth state before any API access", async () => {
  for (const cookie of ["", "sokupa_line_state=wrong"]) {
    const response = await callback(new NextRequest(`${origin}/api/auth/line/callback?code=fake&state=expected`, { headers: { cookie } }));
    assert.equal(response.status, 400);
  }
});

test("job API uses signed session ownership and hides other users' jobs", async () => {
  const savedFetch = global.fetch;
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-fixture";
  const calls: URL[] = [];
  global.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    return new Response(JSON.stringify(url.pathname.endsWith("/users") ? { line_user_id: "owner", display_name: "Test" } : null), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await getJob(new NextRequest(`${origin}/api/analysis-jobs/00000000-0000-4000-8000-000000000000`, { headers: { cookie: `${SESSION_COOKIE}=${signToken("session", "owner", 30)}` } }), { params: { id: "00000000-0000-4000-8000-000000000000" } });
    assert.equal(response.status, 404);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get("line_user_id"), "eq.owner");
    const resumed = await resumeJob(new NextRequest(`${origin}/api/analysis-jobs/00000000-0000-4000-8000-000000000000/resume`, { method: "POST", headers: { origin, cookie: `${SESSION_COOKIE}=${signToken("session", "owner", 30)}` } }), { params: { id: "00000000-0000-4000-8000-000000000000" } });
    assert.equal(resumed.status, 404);
    assert.equal(calls[3].searchParams.get("line_user_id"), "eq.owner");
  } finally {
    global.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test("image path validation excludes other owners, traversal and arbitrary URL fetches", () => {
  const path = "owner/00000000-0000-4000-8000-000000000000.jpg";
  assert.ok(ownedMemoPath(path, "owner"));
  assert.equal(ownedMemoPath(path, "other"), false);
  assert.equal(ownedMemoPath("owner/../other.jpg", "owner"), false);
  assert.equal(memoObjectPath("https://db.example.test/storage/v1/object/public/memo_uploads/uploads/old.jpg", "https://db.example.test"), "uploads/old.jpg");
  assert.throws(() => memoObjectPath("https://evil.test/private", "https://db.example.test"));
});

test("verified legacy login keeps LINE identity and null invite history; new uninvited identity is denied", async () => {
  const savedFetch = global.fetch;
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LINE_LOGIN_CHANNEL_ID", "LINE_LOGIN_CHANNEL_SECRET", "LINE_LOGIN_REDIRECT_URI"];
  const saved = names.map((key) => process.env[key]);
  for (const key of names) process.env[key] = "test-only-fixture";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  const writes: Record<string, unknown>[] = [];
  let exists = true;
  global.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/token")) return json({ access_token: "test-only-access" });
    if (url.pathname.endsWith("/profile")) return json({ userId: "legacy-line-id", displayName: "Synthetic" });
    if (url.pathname.endsWith("/users") && (init?.method ?? "GET") === "GET") return json(exists ? { line_user_id: "legacy-line-id" } : null);
    if (url.pathname.endsWith("/unlimited_users")) return json(null);
    if (url.pathname.endsWith("/users") && init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 201 });
    }
    throw new Error("Unexpected network call in test");
  };
  try {
    const request = () => new NextRequest(`${origin}/api/auth/line/callback?code=fake&state=valid`, { headers: { cookie: "sokupa_line_state=valid" } });
    const response = await callback(request());
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${origin}/`);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].line_user_id, "legacy-line-id");
    assert.equal("invite_code" in writes[0], false);
    const cookie = response.cookies.get(SESSION_COOKIE)!;
    assert.equal(verifyToken(cookie.value, "session")?.subject, "legacy-line-id");
    assert.ok(response.headers.get("set-cookie")?.includes("HttpOnly"));
    exists = false;
    const denied = await callback(request());
    assert.equal(denied.status, 307);
    assert.ok(denied.headers.get("location")?.includes("invite_required"));
    assert.equal(writes.length, 1);
  } finally {
    global.fetch = savedFetch;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("scheduled recovery requires the internal secret and is closed to anonymous requests", async () => {
  assert.equal((await recoverJobs(new NextRequest(`${origin}/api/analysis-jobs/process`))).status, 403);
});

test("disabled background processing refuses new work before creating a job or charging quota", async () => {
  const savedFetch = global.fetch;
  const names = ["ANALYSIS_BACKGROUND_MODE", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((name) => process.env[name]);
  process.env.ANALYSIS_BACKGROUND_MODE = "disabled";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-key";
  let calls = 0;
  global.fetch = async (input) => {
    const url = new URL(String(input));
    assert.ok(url.pathname.endsWith("/users")); calls++;
    return new Response(JSON.stringify({ line_user_id: "owner", display_name: "Synthetic" }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await createJob(new NextRequest(`${origin}/api/analysis-jobs`, { method: "POST", headers: { origin, "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${signToken("session", "owner", 30)}` }, body: JSON.stringify({ image_paths: ["owner/00000000-0000-4000-8000-000000000000.jpg"] }) }));
    assert.equal(response.status, 503); assert.equal(calls, 1);
  } finally { global.fetch = savedFetch; names.forEach((name,index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});

test("scheduled HTTP response waits for its heartbeat; read-only health checks cannot fake scheduler activity", async () => {
  const savedFetch = global.fetch;
  const names = ["ANALYSIS_BACKGROUND_MODE", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((name) => process.env[name]);
  process.env.ANALYSIS_BACKGROUND_MODE = "disabled"; process.env.CRON_SECRET = "synthetic-cron-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-key";
  let enter!: () => void, release!: () => void, settled = false;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  global.fetch = async (input) => {
    const name = new URL(String(input)).pathname.split("/").pop()!; calls.push(name);
    if (name === "analysis_worker_tick_complete") { enter(); await paused; }
    return new Response(JSON.stringify(name === "analysis_admission_ready" ? false : name === "analysis_worker_tick_begin" ? "synthetic-tick" : true), { headers: { "Content-Type": "application/json" } });
  };
  const request = (path: string) => new NextRequest(`${origin}${path}`, { headers: { authorization: "Bearer synthetic-cron-secret" } });
  try {
    const pending = recoverJobs(request("/api/analysis-jobs/process")).then((response) => { settled = true; return response; });
    await entered; assert.equal(settled, false); release();
    const response = await pending;
    assert.equal(response.status, 200); assert.equal((await response.json()).processing_enabled, false);
    assert.deepEqual(calls, ["analysis_worker_tick_begin", "analysis_worker_tick_complete"]);
    process.env.ANALYSIS_BACKGROUND_MODE = "scheduled";
    assert.equal((await workerHealth(request("/api/analysis-jobs/worker-health"))).status, 503);
    assert.equal(calls[calls.length - 1], "analysis_admission_ready");
    assert.equal(calls.filter((name) => name === "analysis_worker_tick_begin").length, 1);
  } finally { release(); global.fetch = savedFetch; names.forEach((name,index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});

test("scheduled HTTP reports 503 and a failed tick when the selected job cannot be read", async () => {
  const savedFetch = global.fetch;
  const names = ["ANALYSIS_BACKGROUND_MODE", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((name) => process.env[name]);
  process.env.ANALYSIS_BACKGROUND_MODE = "scheduled"; process.env.CRON_SECRET = "synthetic-cron-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-key";
  const completed: boolean[] = [];
  global.fetch = async (input,init) => {
    const url = new URL(String(input)), name = url.pathname.split("/").pop();
    assert.equal(url.hostname,"db.example.test");
    if (name === "analysis_worker_tick_complete") { const body=JSON.parse(String(init?.body)); assert.equal(body.p_tick_id,"synthetic-tick");completed.push(body.p_success); }
    const data = name === "analysis_worker_tick_begin" ? "synthetic-tick" : name === "resumable_analysis_jobs" ? [{id:"synthetic-job"}] : name === "analysis_jobs" ? {message:"Synthetic DB job read failure"} : true;
    return new Response(JSON.stringify(data),{status:name === "analysis_jobs" ? 400 : 200,headers:{"Content-Type":"application/json"}});
  };
  try {
    const response=await recoverJobs(new NextRequest(`${origin}/api/analysis-jobs/process`,{headers:{authorization:"Bearer synthetic-cron-secret"}}));
    assert.equal(response.status,503);assert.deepEqual(completed,[false]);
  } finally { global.fetch=savedFetch;names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];}); }
});
