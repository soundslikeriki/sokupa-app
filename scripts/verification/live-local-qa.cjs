// Actual Next + native Supabase extensions + shipped QA adapter; no external provider communication.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {Client}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable stack required');
const state=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}}).find(s=>s.env?.API_URL);
assert.equal(state.runtime,'native');for(const s of [state.env.API_URL,state.env.DB_URL])assert.ok(['127.0.0.1','localhost'].includes(new URL(s).hostname));
const db=new Client({connectionString:state.env.DB_URL,ssl:false,query_timeout:15000});const owner='U'+'1'.repeat(32),cronName='sokupa-iphone-qa-ttl',mode=path.join(root,'qa-next-mode'),events=path.join(root,'qa-next-events.jsonl');
let child,origin,checks=0,prepared=false,originalUsers,uploads=[];
const row=async(s,a)=>(await db.query(s,a)).rows[0],check=(v,message)=>{assert.ok(v,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const wait=async(fn,max=15000)=>{const end=Date.now()+max;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,400));}throw Error('Local QA condition timed out');};
const stage=name=>console.log(JSON.stringify({stage:name,checks,at:new Date().toISOString()}));
const eventRows=()=>fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
const req=(pathname,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
 const url=new URL(pathname,origin);assert.equal(url.origin,origin);const r=https.request(url,{method,headers,ca:fs.readFileSync(path.join(root,'tls/ca-bundle.pem')),timeout:15000},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,headers:res.headers}));});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('local HTTP timeout')));if(body)r.write(body);r.end();
});
(async()=>{await db.connect();assert.ok(fs.realpathSync((await row("select current_setting('data_directory') d")).d).startsWith(fs.realpathSync(root)+path.sep));
 assert.equal((await row('select id from sokupa_local_verification_only')).id,'synthetic-only');
 check((await row("select count(*)::int n from users where line_user_id not in ('local-owner','local-limited')")).n===0,'database contains existing synthetic users only');
 check((await row('select count(*)::int n from cron.job')).n===0,'no existing Cron is running');
 check((await row("select to_regclass('sokupa_qa_limits') present")).present===null,'no prior QA resource-cap table exists');
 originalUsers=(await db.query('select * from users order by line_user_id')).rows;
 const ext=(await db.query("select extname from pg_extension where extname in ('pg_cron','pg_net','supabase_vault')")).rows;check(ext.length===3,'real pg_cron pg_net Vault installed');
 await db.query("select set_analysis_execution_mode('disabled')");await db.query('select configure_analysis_wake(false,null,false)');
 // Platform schema already exists in this disposable stack. Empty bootstrap is separately tested on fresh PG.
 await db.query(`create table public.sokupa_qa_bootstrap(singleton boolean primary key default true check(singleton),version integer not null check(version=1),created_at timestamptz default clock_timestamp());insert into public.sokupa_qa_bootstrap(singleton,version)values(true,1);alter table public.sokupa_qa_bootstrap enable row level security;revoke all on public.sokupa_qa_bootstrap from public,anon,authenticated,service_role;`);prepared=true;
 await db.query(fs.readFileSync('ops/qa/limits.sql','utf8'));
 await db.query("insert into sokupa_qa_limits(singleton,owner_line_user_id,issued_at,expires_at)values(true,$1,clock_timestamp(),clock_timestamp()+interval '80 minutes')",[owner]);
 await db.query('insert into users(line_user_id,display_name)values($1,$2)',[owner,'Synthetic QA']);
 await db.query(fs.readFileSync('ops/cron/supabase-wake.example.sql','utf8'));await db.query(fs.readFileSync('ops/qa/wake-ttl.sql','utf8'));
 fs.writeFileSync(mode,'healthy',{mode:0o600});fs.writeFileSync(events,'',{mode:0o600});const logfile=path.join(root,'qa-next-server.log'),fd=fs.openSync(logfile,'w',0o600);
 child=spawn(process.execPath,['scripts/verification/local-qa-next-server.cjs'],{env:{...process.env,SOKUPA_LOCAL_STACK_ROOT:root},stdio:['ignore',fd,fd]});fs.closeSync(fd);
 origin=await wait(()=>{if(child.exitCode!==null)throw Error('QA fixture server exited');return fs.readFileSync(logfile,'utf8').split('\n').flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}}).find(s=>s.local_qa_next_ready)?.origin;},30000);
 let r=await req('/api/auth/session');const unauth=JSON.parse(r.body);check(r.status===200&&!unauth.authenticated&&unauth.qa.synthetic&&unauth.invited,'real unauthenticated session announces owner-only synthetic QA');
 r=await req('/');check(r.status===200&&r.body.includes('ソクパQA'),'QA build has distinct browser title');
 r=await req('/qa-manifest.webmanifest');check(r.status===200&&JSON.parse(r.body).short_name==='ソクパQA','QA manifest is separate from production PWA');
 r=await req('/api/analysis-jobs');check(r.status===401,'unauthenticated job data denied');
 process.env.SESSION_SECRET=fs.readFileSync(path.join(root,'dispatch-key'),'utf8');const {signToken,SESSION_COOKIE}=require('../../src/lib/session-token.ts');
 const auth={origin,cookie:`${SESSION_COOKIE}=${signToken('session',owner,3600)}`};
 r=await req('/api/analysis-jobs',{headers:{cookie:`${SESSION_COOKIE}=${signToken('session','U'+'2'.repeat(32),3600)}`}});check(r.status===403,'valid signed session for another identity denied');
 r=await req('/api/auth/session',{headers:auth});const session=JSON.parse(r.body);check(r.status===200&&session.admin&&session.qa.synthetic&&session.line_user_id===owner,'real signed QA session keeps the owner unlimited');
 await db.query("select set_analysis_execution_mode('scheduled-wake')");await db.query('select configure_analysis_wake(true,$1,true)',[origin]);
 await db.query("select cron.schedule($1,'* * * * *','select public.sokupa_qa_tick()')",[cronName]);stage('waiting_for_two_real_qa_cron_private_completions');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return(await row("select analysis_admission_ready('scheduled-wake') ready")).ready;},190000);
 check((await row("select count(*)::int n from cron.job_run_details where jobid in(select jobid from cron.job where jobname=$1)and status='succeeded'",[cronName])).n>=2,'two real root Cron/private completions enable QA intake');
 for(let i=0;i<2;i++){r=await req('/api/memo-images',{method:'POST',headers:{...auth,'content-type':'image/jpeg','x-upload-id':crypto.randomUUID()},body:Buffer.from([255,216,255,224])});check(r.status===200,'actual QA upload API writes private Storage');uploads.push(JSON.parse(r.body).object_path);}
 r=await req('/api/analysis-jobs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({image_paths:uploads,site_name:'Synthetic QA closed-screen'})});check(r.status===200,'actual QA job accepted after verified Cron');const job=JSON.parse(r.body).job_id;
 stage('no_browser_job_poll_or_resume');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return(await row('select status from analysis_jobs where id=$1',[job])).status==='done';},190000);
 await wait(async()=>(await row('select notification_status from analysis_jobs where id=$1',[job])).notification_status==='accepted');
 const done=await row('select * from analysis_jobs where id=$1',[job]);check(done.done_images===2&&done.result.items[0].total_m===40&&done.result.items[0].order_quantity===46,'shipped 31-second QA vision finishes both images without browser resume');
 check(eventRows().filter(e=>e.type==='shipped_qa_vision_completed').length===2,'new adapter used exactly twice; no SDK mock responses');
 check(eventRows().filter(e=>e.type==='shipped_qa_notification_accepted').length===1,'job records one shipped synthetic notification');
 check((await row('select count(*)::int n from usage_limits where line_user_id=$1',[owner])).n===0,'admin monthly quota remains untouched');
 const budget=await row('select * from sokupa_qa_limits');check(budget.jobs===1&&budget.images===2&&budget.uploads===2&&Number(budget.upload_bytes)===8,'actual API job/upload work uses atomic QA-only caps');
 const old=(await db.query('select * from users where line_user_id<>$1 order by line_user_id',[owner])).rows;assert.deepEqual(old,originalUsers);checks++;
 // Deliberately expire only this synthetic QA DB configuration and let ACTUAL Cron stop itself.
 await db.query("update sokupa_qa_limits set issued_at=clock_timestamp()-interval '80 minutes',expires_at=clock_timestamp()-interval '1 second'");stage('waiting_for_actual_cron_ttl_stop');
 await wait(async()=>(await row('select count(*)::int n from cron.job where jobname=$1',[cronName])).n===0,90000);
 check((await row('select mode from analysis_execution_policy')).mode==='disabled'&&!(await row('select enabled from analysis_wake_state')).enabled,'real Cron TTL disables wake/intake and removes its schedule');
 const requests=(await row('select count(*)::int n from sokupa_wake_ops.requests')).n;await db.query('select sokupa_qa_tick()');
 check((await row('select count(*)::int n from sokupa_wake_ops.requests')).n===requests,'expired real root tick creates no pg_net request');
 r=await req('/api/analysis-jobs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({image_paths:uploads})});check(r.status===503,'stopped QA cannot accept another analysis');
 fs.writeFileSync(mode,'expired');r=await req('/api/auth/session',{headers:auth});check(r.status===503,'runtime expiry rejects existing signed sessions');
 r=await req('/api/auth/line');check(r.status===503,'runtime expiry blocks OAuth before external token/profile communication');
 r=await req('/api/send-line',{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{"text":"synthetic only"}'});check(r.status===503,'expired runtime cannot send or simulate another notification');
 const result={checks,actualNextHttp:true,realPgCron:true,realPgNet:true,realVaultInstalled:true,shippedQaAdapter:true,actualCronTtlSelfStop:true,noBrowserJobPollOrResume:true,realAiCalls:0,realLineSends:0};fs.writeFileSync(path.join(root,'qa-result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 let cleaned=false;
 if(prepared){try{
  await db.query('select cron.unschedule(jobid)from cron.job where jobname=$1',[cronName]);await db.query('select configure_analysis_wake(false,null,false)');await db.query("select set_analysis_execution_mode('disabled')");
  if(uploads.length){const r=await fetch(new URL('/storage/v1/object/memo_uploads',state.env.API_URL),{method:'DELETE',redirect:'error',headers:{authorization:`Bearer ${state.env.SERVICE_ROLE_KEY}`,apikey:state.env.SERVICE_ROLE_KEY,'content-type':'application/json'},body:JSON.stringify({prefixes:uploads})});assert.ok(r.ok,'Synthetic Storage cleanup succeeds');}
  await db.query('delete from analysis_job_images where job_id in(select id from analysis_jobs where line_user_id=$1)',[owner]);
  await db.query('delete from analysis_jobs where line_user_id=$1',[owner]);await db.query('delete from users where line_user_id=$1',[owner]);
  await db.query('drop trigger if exists qa_job_budget on analysis_jobs;drop function if exists enforce_qa_job_limit();drop function if exists reserve_qa_upload(text,integer);drop function if exists sokupa_qa_tick();drop table if exists sokupa_qa_limits;drop table if exists sokupa_qa_bootstrap;');
  assert.deepEqual((await db.query('select * from users order by line_user_id')).rows,originalUsers);cleaned=true;
 }catch(e){console.error(JSON.stringify({cleanupError:e.message}));process.exitCode=1;}}
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');resolve();},10000);child.once('exit',()=>{clearTimeout(t);resolve();});});}
 await db.end().catch(()=>{});console.log(JSON.stringify({syntheticQaRowsAndObjectsCleaned:cleaned,localNextStopped:!child||child.exitCode!==null}));
});
