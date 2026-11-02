// Actual SDK -> parser -> worker -> actual SQL -> heartbeat/quota. Every HTTP call is mocked.
import {createRequire} from "node:module";
import assert from "node:assert/strict";
import {createClient} from "@supabase/supabase-js";
import {runScheduledAnalysisBatch} from "../../src/lib/analysis-scheduled";
const require=createRequire(import.meta.url);
const {PGlite}=require(process.env.PGLITE_MODULE||"@electric-sql/pglite");
const {setupAnalysisFixture}=require("./analysis-fixture.cjs");
const {primeWorkerHealth}=require("./worker-health-fixture.cjs");
(async()=>{const db=new PGlite(),savedFetch=global.fetch;
 const names=["GEMINI_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","NEXT_PUBLIC_SUPABASE_URL","ANALYSIS_BACKGROUND_MODE","LINE_CHANNEL_ACCESS_TOKEN"];
 const saved=names.map(name=>process.env[name]);
 process.env.GEMINI_API_KEY="synthetic-only";delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;process.env.NEXT_PUBLIC_SUPABASE_URL="https://db.example.test";process.env.ANALYSIS_BACKGROUND_MODE="scheduled";process.env.LINE_CHANNEL_ACCESS_TOKEN="synthetic-only";
 const query=db.query.bind(db),row=async(s:string,a?:unknown[])=>(await query(s,a)).rows[0];
 let checks=0,fixture:number|"network"|"timeout"|"content"|"success"=503,providerCalls=0,lineCalls=0;const finishes:boolean[]=[];
 const check=(value:unknown,message:string)=>{assert.ok(value,message);checks++;};
 const create=async()=>(await row("select create_analysis_job('limited',ARRAY['limited/0.jpg'],'Synthetic',false) id")).id;
 const quota=async()=>(await row("select coalesce(sum(image_count),0)::int n from usage_limits where line_user_id='limited'")).n;
 const advance=async()=>{await query("update analysis_provider_state set blocked_until=now()-interval '1 second'");await query("update analysis_job_images set recovery_not_before=now()-interval '1 second'");};
 const prepare=async()=>{await query('select clear_analysis_provider_block()');await primeWorkerHealth(query);};
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
 global.fetch=async(input,init)=>{
  const url=new URL(String(input)),name=url.pathname.split('/').pop()!,body=init?.body?JSON.parse(String(init.body)):{};
  if(url.hostname==='generativelanguage.googleapis.com'){
   providerCalls++;if(fixture==='network')throw new TypeError('Synthetic dropped connection');if(fixture==='timeout')throw new DOMException('Synthetic timeout','AbortError');
   if(typeof fixture==='number')return json({error:{message:'Synthetic provider failure'}},fixture);
   return json({candidates:[{content:{role:'model',parts:[{text:fixture==='content'?'invalid JSON':JSON.stringify({items:[{product_code:'壁',entries:[{original_formula:'20×1',length_m:20,quantity:1}]}]})}]},finishReason:'STOP'}]});
  }
  if(url.hostname==='api.line.me'){lineCalls++;return json({});}
  assert.equal(url.hostname,'db.example.test','all unexpected external traffic is blocked');
  if(url.pathname.includes('/storage/'))return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
  if(url.pathname.includes('/rpc/')){
   let data;
   if(name==='analysis_worker_tick_begin')data=(await row('select analysis_worker_tick_begin() id')).id;
   else if(name==='analysis_worker_tick_complete'){finishes.push(body.p_success);data=(await row('select analysis_worker_tick_complete($1,$2) ok',[body.p_tick_id,body.p_success])).ok;}
   else if(name==='analysis_processing_secure')data=(await row('select analysis_processing_secure() ok')).ok;
   else if(name==='resumable_analysis_jobs')data=(await query('select * from resumable_analysis_jobs()')).rows;
   else if(name==='claim_analysis_image')data=(await query('select * from claim_analysis_image($1)',[body.p_job_id])).rows;
   else if(name==='defer_analysis_image')data=(await row('select defer_analysis_image($1,$2,$3,$4,$5,$6) state',[body.p_image_id,body.p_lease_token,body.p_code,body.p_retryable,body.p_retry_after_seconds,body.p_delivery_unknown])).state;
   else if(name==='complete_analysis_image')data=(await row('select complete_analysis_image($1,$2,$3) ok',[body.p_image_id,body.p_lease_token,body.p_parsed])).ok;
   else if(name==='fail_analysis_image')data=(await row('select fail_analysis_image($1,$2,$3) ok',[body.p_image_id,body.p_lease_token,body.p_error])).ok;
   else throw new Error('Unexpected RPC '+name);
   return json(data);
  }
  if(name==='analysis_job_images')return json((await query('select * from analysis_job_images where job_id=$1 order by idx',[url.searchParams.get('job_id')!.slice(3)])).rows);
  assert.equal(name,'analysis_jobs');const id=url.searchParams.get('id')!.slice(3);
  if(init?.method==='PATCH'){
   const keys=Object.keys(body);for(const key of keys)assert.match(key,/^[a-z_]+$/);
   const args=Object.values(body);args.push(id);
   const filters=[`id=$${args.length}`];
   if(url.searchParams.has('status'))filters.push("status in ('queued','running')");
   if(url.searchParams.get('notification_attempted_at')==='is.null')filters.push('notification_attempted_at is null');
   if(url.searchParams.get('notification_status')==='neq.accepted')filters.push("notification_status<>'accepted'");
   return json((await query(`update analysis_jobs set ${keys.map((key,i)=>`${key}=$${i+1}`).join(',')} where ${filters.join(' and ')} returning *`,args)).rows[0]??null);
  }
  return json(await row('select * from analysis_jobs where id=$1',[id]));
 };
 try{
  await setupAnalysisFixture(db);await primeWorkerHealth(query);
  const admin=createClient('https://db.example.test','synthetic-key',{auth:{persistSession:false}}),batch=()=>runScheduledAnalysisBatch(admin);
  const job=await create();
  for(let attempt=1;attempt<=3;attempt++){
   await assert.rejects(batch(),/Scheduled processing incomplete/);checks++;
   const image=await row('select * from analysis_job_images where job_id=$1',[job]);
   check(image.attempt_count===attempt,'one provider call per attempt');
   check(image.status===(attempt===3?'failed':'queued'),'provider errors follow bounded retry state');
   check(await quota()===(attempt===3?0:1),'quota held once during retry, returned at final infrastructure failure');await advance();
  }
  check(providerCalls===3,'SDK does not multiply retries inside an attempt');check(finishes.every(v=>v===false),'provider failure never produces a healthy heartbeat');check(lineCalls===0,'failed analysis sends no completion notification');
  await prepare();const auth=await create();fixture=403;await assert.rejects(batch());checks++;
  check((await row('select status from analysis_jobs where id=$1',[auth])).status==='failed','authentication failure stops once');
  check(await quota()===0,'authentication failure returns quota');await batch();
  check(!(await row('select analysis_background_ready() ready')).ready,'empty successful batch cannot clear provider authentication failure');
  for(const value of ['network','timeout'] as const){await prepare();const id=await create();fixture=value;const calls=providerCalls;await assert.rejects(batch());checks++;
   check((await row('select status from analysis_jobs where id=$1',[id])).status==='failed','unknown delivery is terminal');check(await quota()===0,'unknown delivery releases quota');await batch();check(providerCalls===calls+1,'unknown delivery is not automatically repeated');}
  await prepare();const recovered=await create();fixture=503;await assert.rejects(batch());checks++;await advance();fixture='success';await batch();
  check((await row('select status from analysis_jobs where id=$1',[recovered])).status==='done','transient failure can recover through actual SQL and SDK');check(await quota()===1,'recovered image consumes quota once');check(lineCalls===1,'successful recovery notifies once using mocked LINE');
  await prepare();const bad=await create();fixture='content';await batch();
  check((await row('select failure_kind from analysis_jobs where id=$1',[bad])).failure_kind==='job','invalid OCR content stays distinct from provider failure');check(finishes.at(-1)===true,'persisted content failure does not poison worker health');
  console.log(`PASS: ${checks} SDK/worker/SQL provider recovery checks; every HTTP request mocked.`);
 }finally{global.fetch=savedFetch;names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
