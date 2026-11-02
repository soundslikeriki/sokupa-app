import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {NextRequest} from "next/server";
import {verifySchedulerDispatch} from "./scheduler-dispatch";
import {GET} from "../app/api/analysis-jobs/process/route";

const origin="https://worker.example.test",id="00000000-0000-4000-8000-000000000000",key="synthetic-fixture-only-key-00000000000000";
function request(iat:number,exp=iat+120,path="/api/analysis-jobs/process",nonce=id){
  const text=["SOKUPA-DISPATCH-V1","GET",origin,path,nonce,String(iat),String(exp)].join("\n");
  return new NextRequest(origin+path,{headers:{"x-sokupa-dispatch-id":nonce,"x-sokupa-issued-at":String(iat),"x-sokupa-expires-at":String(exp),"x-sokupa-signature":createHmac("sha256",key).update(text).digest("hex")}});
}
test("dedicated dispatch signature is bound to method, origin, path, nonce and a two-minute deadline",()=>{
 const saved=[process.env.ANALYSIS_DISPATCH_SECRET,process.env.ANALYSIS_DISPATCH_ORIGIN];
 process.env.ANALYSIS_DISPATCH_SECRET=key;process.env.ANALYSIS_DISPATCH_ORIGIN=origin;
 try{
  const now=1793650000;assert.equal(verifySchedulerDispatch(request(now),now)?.id,id);
  assert.equal(verifySchedulerDispatch(request(now-121),now),null);
  assert.equal(verifySchedulerDispatch(request(now,now+121),now),null);
  assert.equal(verifySchedulerDispatch(request(now+16),now),null);
  const tampered=request(now);tampered.headers.set("x-sokupa-dispatch-id","00000000-0000-4000-8000-000000000001");assert.equal(verifySchedulerDispatch(tampered,now),null);
  assert.equal(verifySchedulerDispatch(request(now,now+120,"/api/admin/generate-invite"),now),null);
  const valid=request(now);assert.equal(verifySchedulerDispatch(new Request("https://other.example.test/api/analysis-jobs/process",{headers:valid.headers}),now),null);
  assert.equal(verifySchedulerDispatch(new Request(valid.url,{method:"POST",headers:valid.headers}),now),null);
  assert.equal(verifySchedulerDispatch(new Request(valid.url+"?redirect=1",{headers:valid.headers}),now),null);
 }finally{["ANALYSIS_DISPATCH_SECRET","ANALYSIS_DISPATCH_ORIGIN"].forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});
test("signed dispatch claims its nonce before processing and rejects a replay before another heartbeat",async()=>{
 const names=["ANALYSIS_DISPATCH_SECRET","ANALYSIS_DISPATCH_ORIGIN","ANALYSIS_BACKGROUND_MODE","NEXT_PUBLIC_SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRON_SECRET","ANALYSIS_JOB_SECRET"];
 const saved=names.map(name=>process.env[name]),savedFetch=global.fetch;
 process.env.ANALYSIS_DISPATCH_SECRET=key;process.env.ANALYSIS_DISPATCH_ORIGIN=origin;process.env.ANALYSIS_BACKGROUND_MODE="disabled";process.env.NEXT_PUBLIC_SUPABASE_URL="https://db.example.test";process.env.SUPABASE_SERVICE_ROLE_KEY="synthetic-only";delete process.env.CRON_SECRET;delete process.env.ANALYSIS_JOB_SECRET;
 const calls:string[]=[];let claimed=false;
 global.fetch=async(input)=>{const url=new URL(String(input));assert.equal(url.hostname,"db.example.test");const name=url.pathname.split('/').pop()!;calls.push(name);const value=name==='claim_analysis_dispatch'?!claimed:name==='begin_signed_analysis_worker_tick'?'synthetic-tick':true;if(name==='claim_analysis_dispatch')claimed=true;return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});};
 try{
  const now=Math.floor(Date.now()/1000),response=await GET(request(now));assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{processed:0,processing_enabled:false,worker_tick_id:'synthetic-tick',dispatch_id:id});
  assert.equal((await GET(request(now))).status,409);
  assert.deepEqual(calls,["claim_analysis_dispatch","begin_signed_analysis_worker_tick","analysis_worker_tick_complete","claim_analysis_dispatch"]);
  assert.equal((await GET(request(now-121))).status,403);assert.equal(calls.length,4);
 }finally{global.fetch=savedFetch;names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});
