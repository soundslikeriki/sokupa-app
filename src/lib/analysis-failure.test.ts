import test from "node:test";
import assert from "node:assert/strict";
import { providerError } from "./analysis-failure";
import { parseMemoBody } from "./parseMemo";
import { createClient } from "@supabase/supabase-js";
import { runScheduledAnalysisBatch } from "./analysis-scheduled";

test("provider classification separates retryable errors, configuration and unknown delivery", () => {
  for (const status of [429,500,502,503]) assert.equal(providerError({status}).failure.retryable,true);
  for (const status of [401,403]) assert.equal(providerError({status}).failure.code,"authentication");
  for (const status of [400,402,404]) assert.equal(providerError({status}).failure.code,"configuration");
  for (const error of [new TypeError("synthetic network loss"),new DOMException("synthetic abort","AbortError"),new DOMException("synthetic timeout","TimeoutError"),{status:408},{status:504}]) {
    assert.equal(providerError(error).failure.retryable,false);assert.equal(providerError(error).failure.delivery_unknown,true);
  }
  const retry={"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay:"90.5s"};
  assert.equal(providerError({status:429,errorDetails:[retry]}).failure.retry_after_seconds,91);
  assert.equal(providerError({status:429,errorDetails:[{...retry,retryDelay:"3600s"}]}).failure.retryable,false);
  assert.equal(providerError({status:503,message:"secret must not appear"}).message.includes("secret"),false);
});

test("real Gemini SDK errors retain typed infrastructure outcomes without leaking provider messages", async () => {
  const savedFetch=global.fetch,savedKey=process.env.GEMINI_API_KEY,savedGoogleKey=process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  process.env.GEMINI_API_KEY="synthetic-only";delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let fixture: number|"network"|"timeout"|"content"=503;
  global.fetch=async(input)=>{
    assert.equal(new URL(String(input)).hostname,"generativelanguage.googleapis.com");
    if(fixture==="network")throw new TypeError("sensitive upstream detail");
    if(fixture==="timeout")throw new DOMException("sensitive upstream detail","AbortError");
    const data=fixture==="content"?{candidates:[{content:{role:"model",parts:[{text:"not JSON"}]},finishReason:"STOP"}]}:{error:{message:"sensitive upstream detail",details:[{"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay:"95s"}]}};
    return new Response(JSON.stringify(data),{status:typeof fixture==="number"?fixture:200,headers:{"Content-Type":"application/json"}});
  };
  try {
    for(const value of [503,429,401,403,400,408,504,"network","timeout","content"] as const){
      fixture=value;const response=await parseMemoBody({base64Image:"AA=="});const body=await response.json();
      assert.equal(body.failure.kind,value==="content"?"content":"infrastructure",String(value));
      assert.equal(JSON.stringify(body).includes("sensitive upstream detail"),false);
      assert.equal(body.failure.retryable,[503,429].includes(value as number));
      if(value===429)assert.equal(body.failure.retry_after_seconds,95);
    }
  } finally {global.fetch=savedFetch;if(savedKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=savedKey;if(savedGoogleKey===undefined)delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;else process.env.GOOGLE_GENERATIVE_AI_API_KEY=savedGoogleKey;}
});

test("SDK 503 through actual worker defers the lease and fails Cron; it never marks an unreadable image", async () => {
  const names=["GEMINI_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","NEXT_PUBLIC_SUPABASE_URL","ANALYSIS_BACKGROUND_MODE"];
  const saved=names.map(name=>process.env[name]),savedFetch=global.fetch;
  process.env.GEMINI_API_KEY="synthetic-only";delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;process.env.NEXT_PUBLIC_SUPABASE_URL="https://db.example.test";process.env.ANALYSIS_BACKGROUND_MODE="scheduled";
  const finishes:boolean[]=[],deferred:any[]=[];let imageStatus="running",jobStatus="running",providerCalls=0;
  global.fetch=async(input,init)=>{
    const url=new URL(String(input)),name=url.pathname.split("/").pop(),body=init?.body?JSON.parse(String(init.body)):{};
    const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
    if(url.hostname==="generativelanguage.googleapis.com"){providerCalls++;return json({error:{message:"Synthetic provider outage"}},503);}
    assert.equal(url.hostname,"db.example.test");
    if(url.pathname.includes("/storage/"))return new Response(new Uint8Array([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
    if(name==="analysis_worker_tick_begin")return json("synthetic-tick");
    if(name==="analysis_worker_tick_complete"){finishes.push(body.p_success);return json(true);}
    if(name==="analysis_processing_secure")return json(true);
    if(name==="resumable_analysis_jobs")return json([{id:"synthetic-job"}]);
    if(name==="analysis_jobs")return json({id:"synthetic-job",status:jobStatus,total_images:1});
    if(name==="claim_analysis_image")return json([{id:"synthetic-image",idx:0,url:"synthetic/0.jpg",lease_token:"lease"}]);
    if(name==="defer_analysis_image"){deferred.push(body);imageStatus="queued";jobStatus="running";return json("queued");}
    throw new Error(`Unexpected mutation/request: ${name}`);
  };
  try {
    const admin=createClient("https://db.example.test","synthetic-key",{auth:{persistSession:false}});
    await assert.rejects(runScheduledAnalysisBatch(admin),/Scheduled processing incomplete/);
    assert.deepEqual(finishes,[false]);assert.equal(imageStatus,"queued");assert.equal(jobStatus,"running");assert.equal(providerCalls,1);
    assert.equal(deferred[0].p_retryable,true);assert.equal(deferred[0].p_code,"upstream_unavailable");
  } finally {global.fetch=savedFetch;names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});}
});
