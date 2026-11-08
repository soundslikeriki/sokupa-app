import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { AnalysisBudget, AnalysisYield, AnalysisCheckpointError } from "./analysis-budget";
import { imageJournal } from "./analysis-checkpoint";
import { parseMemoBody, type MemoCheckpoint } from "./parseMemo";

const checkpoint: MemoCheckpoint = { version: 1, rawItems: [{product_code:"VS0001",entries:[{original_formula:"2.7×2",length_m:2.7,quantity:2,subtotal_m:5.4}],total_m:5.4}], notes:"Synthetic",imageNeedsReview:false,catalog:{} };
const json = (value: unknown, status=200) => new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});

test("absolute provider/IO budget subtracts preprocessing and reserves persistence/closure",async()=>{
 let clock=0;const budget=new AnalysisBudget(()=>clock);
 assert.equal(budget.remaining(),240_000);assert.equal(budget.providerSignal("vision").aborted,false);
 clock=40_000;assert.equal(budget.remaining(),200_000);
 clock=90_001;assert.throws(()=>budget.providerSignal("vision"),AnalysisYield);
 clock=150_001;assert.throws(()=>budget.providerSignal("catalog"),AnalysisYield);
 let calls=0;const f=budget.fetch(async(_input,init)=>{calls++;assert.ok(init?.signal);return json(true);});
 clock=284_999;await f("https://synthetic.test");clock=285_000;
 await assert.rejects(f("https://synthetic.test"),AnalysisYield);assert.equal(calls,1);
 const aborted=AbortSignal.abort();clock=0;const g=budget.fetch(async(_i,init)=>{assert.equal(init?.signal?.aborted,true);return json(true);});await g("https://synthetic.test",{signal:aborted});
});

for(const mode of ["normal","begin-response-lost","checkpoint-response-lost","begin-not-committed","checkpoint-not-committed","stale-lease"]){
 test(`journal fences external calls and reconciles ${mode}`,async()=>{
  const row:any={pipeline_checkpoint:null,provider_operation:null,lease_token:"lease",status:"running"};let begin=0,saves=0;
  const admin=createClient("https://db.example.test","synthetic",{auth:{persistSession:false},global:{fetch:async(input,init)=>{
   const name=new URL(String(input)).pathname.split('/').at(-1),body=JSON.parse(String(init?.body||'{}'));
   if(name==='analysis_job_images')return json({...row});
   if(name==='begin_analysis_provider'){begin++;if(mode!=='begin-not-committed')row.provider_operation=body.p_operation;return mode.startsWith('begin-')?json({message:'lost'},503):json(true);}
   if(name==='checkpoint_analysis_image'){saves++;assert.equal(body.p_operation,row.provider_operation);if(mode!=='checkpoint-not-committed'){row.pipeline_checkpoint=body.p_checkpoint;row.provider_operation=null;}if(mode==='stale-lease')row.lease_token='new';return mode.startsWith('checkpoint-')||mode==='stale-lease'?json({message:'lost'},503):json(true);}
   throw Error('Unexpected synthetic request');
  }}});
  const journal=await imageJournal(admin,'image','lease');
  if(mode==='begin-not-committed'){await assert.rejects(journal.beforeProvider('vision'),AnalysisCheckpointError);assert.equal(saves,0);return;}
  await journal.beforeProvider('vision');assert.ok(row.provider_operation);
  if(mode==='checkpoint-not-committed'||mode==='stale-lease')await assert.rejects(journal.save(checkpoint),AnalysisCheckpointError);
  else{await journal.save(checkpoint);assert.equal(row.provider_operation,null);assert.deepEqual(row.pipeline_checkpoint.rawItems,checkpoint.rawItems);}
  assert.equal(begin,1);assert.equal(saves,1);
 });
}

test("OCR survives a late invocation; next invocation resumes catalog without repeating vision",async()=>{
 const names=['GEMINI_API_KEY','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'],saved=names.map(n=>process.env[n]),original=global.fetch;
 process.env.GEMINI_API_KEY='synthetic';process.env.NEXT_PUBLIC_SUPABASE_URL='https://db.example.test';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic';
 let clock=0,vision=0,catalog=0,preserved:MemoCheckpoint|null=null;const stages:string[]=[];
 const budget=new AnalysisBudget(()=>clock);
 global.fetch=async(input)=>{const url=new URL(String(input));
  if(url.hostname==='db.example.test')return json(null);
  assert.equal(url.hostname,'generativelanguage.googleapis.com');
  if(!vision){vision++;clock=210_000;return json({candidates:[{content:{parts:[{text:JSON.stringify({items:checkpoint.rawItems,notes:'Synthetic'})}]}}]});}
  catalog++;return json({error:{code:503,message:'Synthetic unavailable'}},503);
 };
 try{
  const admin=createClient('https://db.example.test','synthetic',{auth:{persistSession:false}});
  const hooks={admin,budget,checkpoint:null,beforeProvider:async(stage:string)=>{stages.push(stage);},save:async(c:MemoCheckpoint)=>{preserved=structuredClone(c);}};
  await assert.rejects(parseMemoBody({base64Image:'AA=='},hooks),AnalysisYield);
  assert.equal(vision,1);assert.equal(catalog,0);assert.ok(preserved);assert.deepEqual(stages,['vision']);
  const response=await parseMemoBody({base64Image:'AA=='},{...hooks,budget:new AnalysisBudget(),checkpoint:preserved});
  assert.equal(response.status,200);assert.equal(vision,1);assert.equal(catalog,1);
  const payload=await response.json();assert.equal(payload.data.items[0].total_m,5.4);assert.equal(payload.data.items[0].needs_review,true);assert.notEqual(payload.data.items[0].repeat_info?.from_product,'無地');assert.equal((preserved as unknown as MemoCheckpoint).catalog[0].is_live_searched,false);
 }finally{global.fetch=original;names.forEach((n,i)=>saved[i]===undefined?delete process.env[n]:process.env[n]=saved[i]);}
});

test("late finalization defers LINE without recording an attempt or changing completed quantities",async()=>{
 const {processAnalysisJobStep}=await import('./analysisJobProcessor');let clock=0;const budget=new AnalysisBudget(()=>clock);clock=245_000;const calls:string[]=[];
 const admin=createClient('https://db.example.test','synthetic',{auth:{persistSession:false},global:{fetch:async(input)=>{const name=new URL(String(input)).pathname.split('/').at(-1)!;calls.push(name);return json({id:'job',status:'done',notification_status:'pending',notification_protocol:'line_retry_v1',result:{items:[]}});}}});
 assert.equal((await processAnalysisJobStep({admin,jobId:'job',budget})).status,'done');assert.deepEqual(calls,['analysis_jobs']);
});

test("LINE acceptance followed by record failure retries only the original stable key",async()=>{
 const {processAnalysisJobStep}=await import('./analysisJobProcessor');const savedFetch=global.fetch,savedToken=process.env.LINE_CHANNEL_ACCESS_TOKEN;process.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic';
 const job:any={id:'00000000-0000-4000-8000-000000000001',status:'done',line_user_id:'synthetic',notification_status:'pending',notification_protocol:'line_retry_v1',result:{items:[{product_code:'SYN',entries:[{original_formula:'2×1',length_m:2,quantity:1,subtotal_m:2}],total_m:2,order_quantity:3}]}};let fail=true;const keys:string[]=[];
 global.fetch=async(input,init)=>{const url=new URL(String(input));if(url.hostname==='api.line.me'){keys.push(new Headers(init?.headers).get('X-Line-Retry-Key')!);return keys.length===1?json({}):new Response(null,{status:409,headers:{'x-line-accepted-request-id':'synthetic'}});}
  assert.equal(url.hostname,'db.example.test');if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));if(body.notification_status==='accepted'&&fail)return json({message:'Synthetic record outage'},503);Object.assign(job,body);}return json({...job});};
 try{const admin=createClient('https://db.example.test','synthetic',{auth:{persistSession:false}});assert.equal((await processAnalysisJobStep({admin,jobId:job.id})).failureKind,'infrastructure');assert.equal(job.notification_status,'pending');fail=false;assert.equal((await processAnalysisJobStep({admin,jobId:job.id})).status,'done');assert.equal(job.notification_status,'accepted');assert.deepEqual(keys,[job.id,job.id]);}finally{global.fetch=savedFetch;if(savedToken===undefined)delete process.env.LINE_CHANNEL_ACCESS_TOKEN;else process.env.LINE_CHANNEL_ACCESS_TOKEN=savedToken;}
});

test("legacy direct OCR endpoint has no unjournaled external-call path",async()=>{
 const {POST}=await import('../app/api/parse-memo/route');const {NextRequest}=await import('next/server');const key=process.env.ANALYSIS_JOB_SECRET,saved=global.fetch;process.env.ANALYSIS_JOB_SECRET='synthetic';let requests=0;global.fetch=async()=>{requests++;throw Error('No external call allowed');};
 try{const response=await POST(new NextRequest('https://app.example.test/api/parse-memo',{method:'POST',headers:{'x-job-secret':'synthetic'}}));assert.equal(response.status,409);assert.equal(requests,0);}finally{global.fetch=saved;if(key===undefined)delete process.env.ANALYSIS_JOB_SECRET;else process.env.ANALYSIS_JOB_SECRET=key;}
});

test("one slow image leaves the next image unclaimed in the same invocation",async()=>{
 const {runAnalysisJob}=await import('./analysisJobProcessor');const saved=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://db.example.test';let clock=0,claims=0,parses=0;const budget=new AnalysisBudget(()=>clock);
 const admin=createClient('https://db.example.test','synthetic',{auth:{persistSession:false},global:{fetch:async(input)=>{const url=new URL(String(input)),name=url.pathname.split('/').at(-1);if(url.pathname.includes('/storage/'))return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});if(name==='analysis_jobs')return json({id:'job',status:'running',total_images:2});if(name==='claim_durable_analysis_image'){claims++;return json([{id:'image',idx:0,url:'synthetic/0.jpg',lease_token:'lease'}]);}if(name==='complete_analysis_image')return json(true);if(name==='analysis_job_images')return json([{idx:0,status:'done',parsed:{items:[{}]}},{idx:1,status:'queued'}]);throw Error('Unexpected request');}}});
 try{assert.equal((await runAnalysisJob({admin,jobId:'job',budget,parse:async()=>{parses++;clock=210_000;return json({data:{items:checkpoint.rawItems}});}})).status,'running');assert.equal(claims,1);assert.equal(parses,1);}finally{if(saved===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=saved;}
});
