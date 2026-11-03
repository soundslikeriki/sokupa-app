// Latest real Next HTTP -> REST/SQL verification for result discovery/receipt. No OCR or LINE calls.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{Client}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable root required');
const state=fs.readFileSync(root+'/start.log','utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.DB_URL);assert.equal(state.runtime,'native');for(const u of [state.env.DB_URL,state.env.API_URL])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(u).hostname));
const db=new Client({connectionString:state.env.DB_URL,ssl:false}),sleep=ms=>new Promise(r=>setTimeout(r,ms));let child,origin,checks=0,id;const check=(v,m)=>{assert.ok(v,m);checks++;console.log(JSON.stringify({check:checks,message:m}));};
const http=(route,{user='local-owner',method='GET'}={})=>new Promise((resolve,reject)=>{
 const cookie=user?`${sessionCookie}=${sign('session',user,3600)}`:'';
 const r=https.request(new URL(route,origin),{method,ca:fs.readFileSync(root+'/tls/ca-bundle.pem'),headers:{origin,cookie},timeout:10000},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body||'{}')}));});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('local timeout')));r.end();
});let sign,sessionCookie;
(async()=>{
 await db.connect();const directory=(await db.query("select current_setting('data_directory') d")).rows[0].d;assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(root)+path.sep));assert.equal((await db.query('select id from sokupa_local_verification_only')).rows[0].id,'synthetic-only');
 check((await db.query("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).rows[0].n===0,'no Cron runs during recovery API verification');
 await db.query("select set_analysis_execution_mode('scheduled-wake');select configure_analysis_wake(false,null,false);notify pgrst,'reload schema'");
 const payload={items:[{product_code:'LOCAL',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23}]};
 id=(await db.query("insert into analysis_jobs(line_user_id,status,total_images,done_images,notification_status,result,execution_mode)values('local-owner','done',1,1,'accepted',$1,'interactive')returning id",[payload])).rows[0].id;
 fs.writeFileSync(root+'/wake-next-mode','healthy',{mode:0o600});fs.writeFileSync(root+'/wake-next-events.jsonl','',{mode:0o600});const log=fs.openSync(root+'/recovery-next-server.log','w',0o600);
 child=spawn(process.execPath,['scripts/verification/local-wake-next-server.cjs'],{env:process.env,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('local Next exited');const rows=fs.readFileSync(root+'/recovery-next-server.log','utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}});origin=rows.find(x=>x.local_wake_next_ready)?.origin;if(origin)break;await sleep(200);}if(!origin)throw Error('local Next not ready');
 process.env.SESSION_SECRET=fs.readFileSync(root+'/dispatch-key','utf8');const tokens=require('../../src/lib/session-token.ts');sign=tokens.signToken;sessionCookie=tokens.SESSION_COOKIE;
 let r=await http('/api/analysis-jobs');check(r.status===200&&r.body.data.some(j=>j.id===id),'actual owner discovery finds an accepted result without any device pointer');
 r=await http('/api/analysis-jobs',{user:null});check(r.status===401,'unsigned discovery is refused');
 r=await http('/api/analysis-jobs',{user:'local-limited'});check(r.status===200&&!r.body.data.some(j=>j.id===id),'another user cannot discover the result');
 r=await http('/api/analysis-jobs/'+id);check(r.status===200&&r.body.data.execution_mode==='scheduled-wake','actual DB trigger stamps the server policy at acceptance');check(r.body.data.background_ready===false,'stopped scheduler cannot inherit a closed-screen promise from the session');
 r=await http('/api/analysis-jobs/'+id+'/seen',{user:'local-limited',method:'POST'});check(r.status===404,'another user cannot mark a result viewed');
 r=await http('/api/analysis-jobs/'+id+'/seen',{method:'POST'});check(r.status===200,'owner receipt saves through the actual Next/REST API');
 r=await http('/api/analysis-jobs');check(r.status===200&&!r.body.data.some(j=>j.id===id),'durably stored result no longer needs automatic rediscovery');
 check(!fs.readFileSync(root+'/wake-next-events.jsonl','utf8').includes('synthetic_'),'recovery API test invokes neither AI nor LINE');
 const result={checks,actualNextHttpEntry:true,realSupabaseRest:true,realAiCalls:0,realLineSends:0};fs.writeFileSync(root+'/recovery-result.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},10000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
 if(id)await db.query('delete from analysis_jobs where id=$1',[id]).catch(()=>{});await db.query("select set_analysis_execution_mode('disabled')").catch(()=>{});await db.end().catch(()=>{});
 console.log(JSON.stringify({localNextStopped:!child||child.exitCode!==null}));
});
