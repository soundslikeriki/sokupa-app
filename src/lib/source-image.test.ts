import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../app/api/analysis-jobs/[id]/images/[index]/route";
import { signToken, SESSION_COOKIE } from "./session-token";
process.env.SESSION_SECRET = "synthetic-source-photo-secret-0000000000";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-key";
const id = "00000000-0000-4000-8000-000000000001";
const request = () => new NextRequest(`https://app.example.test/api/analysis-jobs/${id}/images/0`, { headers: { cookie: `${SESSION_COOKIE}=${signToken("session","owner",30)}` } });
test("source photo access requires a signed owner and stops before another owner's images", async () => {
  const anonymous = await GET(new NextRequest(`https://app.example.test/api/analysis-jobs/${id}/images/0`), { params: Promise.resolve({ id, index: "0" }) });
  assert.equal(anonymous.status, 401);
  const saved = global.fetch, calls: URL[] = [];
  global.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input)); calls.push(url);
    if (url.pathname.endsWith("/users")) return Response.json({ line_user_id: "owner" });
    assert.equal(url.searchParams.get("line_user_id"), "eq.owner"); return Response.json(null);
  };
  try { assert.equal((await GET(request(), { params: Promise.resolve({ id, index: "0" }) })).status,404); assert.equal(calls.length,2); }
  finally { global.fetch = saved; }
});
test("owner photo downloads through private Storage and returns image bytes with no public cache", async () => {
  const saved = global.fetch;
  global.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/users")) return Response.json({ line_user_id: "owner" });
    if (url.pathname.endsWith("/analysis_jobs")) { assert.equal(url.searchParams.get("line_user_id"),"eq.owner"); return Response.json({ id }); }
    if (url.pathname.endsWith("/analysis_job_images")) { assert.equal(url.searchParams.get("idx"),"eq.0"); return Response.json({ url: `owner/${id}.jpg` }); }
    assert.equal(url.origin,"https://db.example.test"); assert.ok(url.pathname.startsWith("/storage/v1/object/"));
    return new Response(new Uint8Array([255,216,255,224]),{headers:{"Content-Type":"image/jpeg"}});
  };
  try { const r=await GET(request(),{params:Promise.resolve({id,index:"0"})}); assert.equal(r.status,200); assert.equal(r.headers.get("cache-control"),"private, no-store"); assert.equal((await r.arrayBuffer()).byteLength,4); }
  finally { global.fetch=saved; }
});
