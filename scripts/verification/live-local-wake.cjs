// Actual Next HTTP -> SDK -> native Supabase -> real pg_cron/pg_net; OCR/LINE are synthetic only.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const{Client,Pool}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable stack required');
const state=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.API_URL);
assert.equal(state.runtime,'native');for(const u of [state.env.DB_URL,state.env.API_URL])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(u).hostname));
const config={connectionString:state.env.DB_URL,ssl:false,connectionTimeoutMillis:5000,query_timeout:15000},db=new Client(config),pool=new Pool({...config,max:12});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),row=async(s,a)=>(await db.query(s,a)).rows[0];let checks=0,child,origin,cronId;
const cronName='sokupa-local-secret-free-wake',mode=path.join(root,'wake-next-mode'),events=path.join(root,'wake-next-events.jsonl');
const check=(v,message)=>{assert.ok(v,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const stage=s=>console.log(JSON.stringify({stage:s,checks,at:new Date().toISOString()}));
const wait=async(fn,max=15000)=>{const end=Date.now()+max;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(400);}throw Error('Local wake condition timed out');};
const service=async(s,a)=>{const c=await pool.connect();try{await c.query('set role service_role');return(await c.query(s,a)).rows;}finally{await c.query('reset role');c.release();}};
const ready=async()=>(await row("select analysis_admission_ready('scheduled-wake') ready")).ready;
const request=(pathname,{body,headers={},method='POST'}={})=>new Promise((resolve,reject)=>{
 const target=new URL(pathname,origin);assert.equal(target.origin,origin);
 const req=https.request(target,{method,headers,ca:fs.readFileSync(path.join(root,'tls/ca-bundle.pem')),timeout:12000},res=>{
  let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:data,headers:res.headers}));
 });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('local HTTP timeout')));if(body)req.write(body);req.end();
});
const eventRows=()=>fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
(async()=>{
 await db.connect();assert.ok(fs.realpathSync((await row("select current_setting('data_directory') d")).d).startsWith(fs.realpathSync(root)+path.sep));assert.equal((await row('select id from sokupa_local_verification_only')).id,'synthetic-only');
 check((await row("select count(*)::int n from users where line_user_id not in ('local-owner','local-limited')")).n===0,'only synthetic users exist in the disposable database');
 check((await row("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).n===0,'no prior verification Cron is active');
 const userIds=(await db.query('select line_user_id from users order by line_user_id')).rows;
 if(!(await row("select to_regclass('analysis_wake_state') present")).present)await db.query(fs.readFileSync('supabase/migrations/20261103073534_secret_free_wake_permits.sql','utf8'));
 if(!(await row("select to_regprocedure('public.lock_analysis_wake_state()') present")).present)await db.query(fs.readFileSync('supabase/migrations/20261103083839_wake_lock_and_clock_order.sql','utf8'));
 await db.query('update sokupa_ops.scheduler_config set enabled=false where enabled');
 await db.query(fs.readFileSync('ops/cron/supabase-wake.example.sql','utf8'));
 fs.writeFileSync(mode,'healthy',{mode:0o600});fs.writeFileSync(events,'',{mode:0o600});
 const log=fs.openSync(path.join(root,'wake-next-server.log'),'w',0o600);
 child=spawn(process.execPath,['scripts/verification/local-wake-next-server.cjs'],{env:{...process.env,SOKUPA_LOCAL_STACK_ROOT:root},stdio:['ignore',log,log]});fs.closeSync(log);
 origin=await wait(async()=>{if(child.exitCode!==null)throw Error('Local Next fixture exited');const rows=fs.readFileSync(path.join(root,'wake-next-server.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}});return rows.find(x=>x.local_wake_next_ready)?.origin;},30000);
 check(new URL(origin).hostname==='localhost','actual Next HTTP entry is TLS localhost only');
 const beforeSignals=(await row('select count(*)::int n from analysis_wake_permits')).n;
 let r=await request('/api/analysis-jobs/wake',{body:'{"job_id":"forged"}'});check(r.status===204&&r.body==='','public wake response has no data before configuration');
 check((await row('select count(*)::int n from analysis_wake_permits')).n===beforeSignals,'an HTTP request cannot create a private permit');
 await db.query("select set_analysis_execution_mode('scheduled-wake')");await db.query('select configure_analysis_wake(true,$1,true)',[origin]);
 // Real multiple connections contend for one root-created permit. No clock adjustment.
 const permit=(await row('select issue_analysis_wake_permit() id')).id;
 const claimed=(await Promise.all(Array.from({length:12},()=>service('select * from claim_analysis_wake($1,true)',[origin])))).flat();
 check(claimed.length===1&&claimed[0].permit_id===permit,'12 real PostgreSQL connections consume one private permit exactly once');
 const claim=claimed[0];await service('select analysis_worker_tick_complete($1,false)',[claim.worker_tick_id]);await service('select complete_analysis_wake($1,$2,false)',[claim.permit_id,claim.claim_token]);
 await db.query('select configure_analysis_wake(true,$1,true)',[origin]);check(!(await ready()),'concurrency fixture cannot manufacture ready state');
 // Official Cron scheduling and pg_net HTTP: no browser, no resume calls, no time manipulation.
 cronId=(await row("select cron.schedule($1,'* * * * *',$2) id",[cronName,'select sokupa_wake_ops.reconcile();select sokupa_wake_ops.enqueue();'])).id;
 stage('waiting_for_two_real_minute_cron_private_completions');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return await ready();},190000);
 check(await ready(),'two actual Cron HTTP requests through real Next establish private worker health');
 check((await row('select count(*)::int n from cron.job_run_details where jobid=$1 and status=\'succeeded\'',[cronId])).n>=2,'two real Cron executions are recorded');
 const s=(await row('select * from analysis_wake_state'));check(s.origin===origin&&s.expect_processing,'fixed target and processing mode are private root configuration');
 // Stop pg_net briefly to inspect its real queued payload. No extension ACL/role/ownership changes.
 await db.query('begin');const nextId=(await row("select net.http_post(url:=$1,body:='{}',headers:='{}') id",[origin+'/api/analysis-jobs/wake'])).id;
 const queued=await row('select url,headers,body from net.http_request_queue where id=$1',[nextId]);
 check(queued.url===origin+'/api/analysis-jobs/wake'&&JSON.stringify(queued.headers).toLowerCase().includes('authorization')===false,'real pg_net queue contains no credentials in URL or headers');
 check(Buffer.from(queued.body).toString()==='{}','real pg_net request body contains no permit, job or user ID');await db.query('rollback');
 process.env.SESSION_SECRET=fs.readFileSync(path.join(root,'dispatch-key'),'utf8');const{signToken,SESSION_COOKIE}=require('../../src/lib/session-token.ts');
 const auth={origin,cookie:`${SESSION_COOKIE}=${signToken('session','local-owner',3600)}`};
 r=await request('/api/auth/session',{method:'GET',headers:auth});const session=JSON.parse(r.body);check(r.status===200&&session.admin&&session.line_user_id==='local-owner','real HTTP signed session preserves owner identity and admin');
 const images=[];for(let i=0;i<2;i++){
  r=await request('/api/memo-images',{headers:{...auth,'Content-Type':'image/jpeg','x-upload-id':crypto.randomUUID()},body:Buffer.from([255,216,255,224])});check(r.status===200,'actual Next upload API writes private Storage');images.push(JSON.parse(r.body).object_path);
 }
 r=await request('/api/analysis-jobs',{headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({image_paths:images,site_name:'Synthetic closed-screen'})});check(r.status===200,'actual Next API accepts two images');const job=JSON.parse(r.body).job_id;
 stage('browser_closed_no_job_poll_or_resume_http_requests');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return(await row('select status from analysis_jobs where id=$1',[job])).status==='done';},190000);
 await wait(async()=>(await row('select notification_status from analysis_jobs where id=$1',[job])).notification_status==='accepted');
 const final=await row('select * from analysis_jobs where id=$1',[job]);
 check(final.done_images===2&&final.result.items[0].total_m===40&&final.result.items[0].order_quantity===46,'two 31-second images finish and sum correctly without any browser polling/resume');
 check(eventRows().filter(x=>x.type==='synthetic_vision_started').length===2,'each image calls the synthetic AI once');check(eventRows().filter(x=>x.type==='synthetic_line_accepted').length===1,'closed-screen completion produces one synthetic LINE acceptance');
 check((await row("select count(*)::int n from usage_limits where line_user_id='local-owner'")).n===0,'admin remains unlimited');
 check(JSON.stringify((await db.query('select line_user_id from users order by line_user_id')).rows)===JSON.stringify(userIds),'every existing fixture user ID is unchanged');
 fs.writeFileSync(mode,'401');stage('waiting_for_real_http401_and_fail_closed_gate');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return(await row('select failure_code from analysis_wake_state')).failure_code==='transport_failed';},90000);
 check(!(await ready()),'observed real HTTP401 closes intake despite previously healthy private completions');
 await assert.rejects(service('select create_analysis_job($1,$2,null,false)',['local-limited',['local-limited/0.jpg']]),/worker_unavailable/);checks++;
 check((await row("select count(*)::int n from usage_limits where line_user_id='local-limited'")).n===0,'failed transport does not reserve general-user quota');
 fs.writeFileSync(mode,'healthy');stage('waiting_for_two_real_recovery_cron_private_completions');
 await wait(async()=>{await db.query('select sokupa_wake_ops.reconcile()');return await ready();},190000);
 check(await ready(),'two fresh real Cron/private completions recover after HTTP401');
 const result={checks,actualNextHttpEntry:true,realCron:true,realPgNet:true,noBrowserJobPollOrResume:true,realAiCalls:0,realLineSends:0,syntheticVisionCalls:eventRows().filter(x=>x.type==='synthetic_vision_started').length,syntheticLineAcceptances:eventRows().filter(x=>x.type==='synthetic_line_accepted').length,extensionAclMutations:0};
 fs.writeFileSync(path.join(root,'wake-result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 let cronStopped=false;
 try{await db.query('select cron.unschedule(jobid) from cron.job where jobname=$1',[cronName]);cronStopped=(await row('select count(*)::int n from cron.job where jobname=$1',[cronName])).n===0;}catch{process.exitCode=1;}
 try{await db.query('select configure_analysis_wake(false,$1,false)',[origin??null]);await db.query("select set_analysis_execution_mode('disabled')");}catch{process.exitCode=1;}
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},10000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
 await pool.end().catch(()=>{});await db.end().catch(()=>{});console.log(JSON.stringify({localNextStopped:!child||child.exitCode!==null,localCronStopped:cronStopped}));
});
