// Isolated real PostgreSQL, synthetic data only. Unix socket in a private temp dir; no TCP.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const assert=require('node:assert/strict');
const {Client,Pool}=require(process.env.PG_CLIENT_MODULE||'pg');
const {elapseHealthClock,primeWorkerHealth}=require('./worker-health-fixture.cjs');
const {createHmac}=require('node:crypto');
const {elapseTransportClock}=require('./transport-fixture.cjs');
const bin=process.env.PG_TEST_BIN;
if(!bin)throw new Error('PG_TEST_BIN must point to an isolated PostgreSQL binary directory');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sokupa-pg-concurrency-'));fs.chmodSync(root,0o700);
 const data=path.join(root,'data'),socket=path.join(root,'socket');fs.mkdirSync(socket,{mode:0o700});
 const config={host:socket,port:55479,user:'postgres',password:'',database:'postgres',connectionTimeoutMillis:1000,query_timeout:10000,ssl:false};
 let server,admin,pool,checks=0,logs='';
 const check=(value,msg)=>{assert.ok(value,msg);checks++;};
 try{
  execFileSync(path.join(bin,'initdb'),['-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
  server=spawn(path.join(bin,'postgres'),['-D',data,'-k',socket,'-p','55479','-c','listen_addresses=','-c','max_connections=30'],{stdio:['ignore','pipe','pipe']});
  server.stderr.on('data',chunk=>{logs+=String(chunk)});
  server.on('error',error=>{logs+=error.message});
  for(let i=0;i<50;i++){
   const client=new Client(config);
   try{await client.connect();admin=client;break;}catch{await client.end().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,100));}
  }
  if(!admin)throw new Error('Local PostgreSQL failed to start: '+logs.slice(-800));
  pool=new Pool({...config,max:12});
  const service=async(sql,args)=>{const client=await pool.connect();try{await client.query('set role service_role');return(await client.query(sql,args)).rows;}finally{await client.query('reset role');client.release();}};
  const row=async(sql,args)=>(await admin.query(sql,args)).rows[0];
  const version=(await row('select version() v')).v;check(version.includes('17.6'),'matching PostgreSQL version');
  await admin.query(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema storage;grant usage on schema public,storage to anon,authenticated,service_role;
   create table users(line_user_id text primary key,display_name text,picture_url text,invite_code text,last_login_at timestamptz);
   create table invite_codes(code text primary key,is_used boolean,used_at timestamptz);
   create table unlimited_users(line_user_id text primary key);
   create table usage_limits(line_user_id text,year_month text,image_count integer,updated_at timestamptz,unique(line_user_id,year_month));
   create table analysis_jobs(id uuid primary key default gen_random_uuid(),updated_at timestamptz default now(),line_user_id text,status text default 'queued',site_name text,context jsonb,total_images integer,done_images integer default 0,result jsonb,error text);
   create table analysis_job_images(id uuid primary key default gen_random_uuid(),job_id uuid references analysis_jobs(id),idx integer,url text,status text default 'queued',parsed jsonb,error text,updated_at timestamptz default now());
   create table storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id int);alter table storage.objects enable row level security;
   insert into storage.buckets(id,public)values('memo_uploads',true);
   grant all on all tables in schema public,storage to service_role;
   insert into users(line_user_id)values('owner'),('limited'),('refund-only');`);
  for(const file of ['supabase/migrations/20261102183016_session_api_expansion.sql','supabase/migrations/20261102190336_analysis_image_leases.sql','supabase/migrations/20261102193554_notification_upgrade_and_worker_health.sql','supabase/migrations/20261102203127_verified_worker_success_ticks.sql','supabase/migrations/20261102205248_provider_failure_recovery.sql','supabase/rollout/20261102183142_restrict_private_data_access.sql'])await admin.query(fs.readFileSync(file,'utf8'));
  await primeWorkerHealth(admin.query.bind(admin));
  check((await service('select analysis_background_ready() ready'))[0].ready,'service role can confirm readiness after closed grants');
  const create=async(count=1,user='owner',owner=true)=>(await service('select create_analysis_job($1,$2,$3,$4) id',[user,Array.from({length:count},(_,i)=>`${user}/${i}.jpg`),'Synthetic',owner]))[0].id;
  const claim=job=>service('select * from claim_analysis_image($1)',[job]);
  const payload={items:[{product_code:'VS2067',manufacturer:'Synthetic',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23}]};
  const job=await create(2);
  const claims=(await Promise.all(Array.from({length:8},()=>claim(job)))).flat();
  check(claims.length===1,'8 connections claim one image, not two images in the same job');
  const first=claims[0];check(first.attempt_count===1,'parallel claims increment attempts once');
  const completions=(await Promise.all(Array.from({length:8},()=>service('select complete_analysis_image($1,$2,$3) ok',[first.id,first.lease_token,payload])))).flat();
  check(completions.filter(r=>r.ok).length===1,'8 concurrent commits produce one successful completion');
  check((await row('select done_images from analysis_jobs where id=$1',[job])).done_images===1,'progress increments once');
  const second=(await claim(job))[0];check(second.idx===1,'next image is available after first completion');
  await admin.query("update analysis_job_images set lease_expires_at=now()-interval '1 second' where id=$1",[second.id]);
  const renewed=(await Promise.all(Array.from({length:8},()=>claim(job)))).flat();
  check(renewed.length===1&&renewed[0].lease_token!==second.lease_token,'expiry permits exactly one new lease');
  check((await service('select complete_analysis_image($1,$2,$3) ok',[second.id,second.lease_token,payload]))[0].ok===false,'stale completion is fenced');
  check((await service('select fail_analysis_image($1,$2,$3) ok',[second.id,second.lease_token,'stale']))[0].ok===false,'stale failure is fenced');
  check((await service('select complete_analysis_image($1,$2,$3) ok',[renewed[0].id,renewed[0].lease_token,payload]))[0].ok,'new lease completes');
  const blocked=await create(),independent=await create();
  await admin.query('begin');await admin.query('select id from analysis_jobs where id=$1 for update',[blocked]);
  let released=false;const waiting=claim(blocked).then(rows=>{released=true;return rows});
  await new Promise(resolve=>setTimeout(resolve,100));check(!released,'job row lock blocks a competing claim');
  check((await claim(independent)).length===1,'another job proceeds while first job is locked');
  await admin.query('commit');check((await waiting).length===1,'waiting claimant proceeds after transaction commit');
  await admin.query("insert into usage_limits values('limited',to_char(now() at time zone 'Asia/Tokyo','YYYY-MM'),19,now())");
  const quota=await Promise.allSettled(Array.from({length:8},()=>create(1,'limited',false)));
  check(quota.filter(r=>r.status==='fulfilled').length===1,'8 quota reservations permit only the last remaining image');
  check(quota.filter(r=>r.status==='rejected'&&String(r.reason).includes('monthly_limit')).length===7,'other reservations roll back with monthly limit');
  check((await row("select image_count from usage_limits where line_user_id='limited'")).image_count===20,'monthly counter is exactly 20');
  check((await row("select count(*)::int n from analysis_jobs where line_user_id='limited'")).n===1,'rejected reservations create no orphan jobs');
  check((await Promise.all(Array.from({length:8},()=>create()))).length===8,'owner remains unlimited under concurrent creation');
  check((await row("select count(*)::int n from usage_limits where line_user_id='owner'")).n===0,'owner consumes no monthly quota');
  const beginTick=async()=>(await service('select analysis_worker_tick_begin() id'))[0].id;
  const finishTick=async(id,success=true)=>(await service('select analysis_worker_tick_complete($1,$2) ok',[id,success]))[0].ok;
  const healthy=async()=>(await service('select analysis_background_ready() ready'))[0].ready;
  await finishTick(await beginTick(),false);
  const parallelTicks=await Promise.all(Array.from({length:8},()=>beginTick()));
  await Promise.all(parallelTicks.map(id=>finishTick(id)));
  check(new Set(parallelTicks).size===8,'8 concurrent health starts have unique IDs');
  check(!(await healthy()),'8 concurrent successes cannot fake two spaced healthy calls');
  const duplicateResults=await Promise.all(Array.from({length:8},()=>finishTick(parallelTicks[0])));
  check(duplicateResults.every(Boolean),'concurrent same-outcome completion retries are idempotent');
  check(!(await healthy()),'duplicate callbacks do not add success timestamps');
  await elapseHealthClock(admin.query.bind(admin),60);
  await finishTick(await beginTick());check(await healthy(),'a second spaced success opens intake across real connections');
  const oldTick=await beginTick(),failedTick=await beginTick();
  await Promise.all([finishTick(failedTick,false),finishTick(oldTick)]);
  check(!(await healthy()),'concurrent failure and older success always leave intake closed');
  await elapseHealthClock(admin.query.bind(admin),60);await finishTick(await beginTick());
  check(!(await healthy()),'one recovery success cannot reuse successes from before failure');
  await elapseHealthClock(admin.query.bind(admin),60);await finishTick(await beginTick());
  check(await healthy(),'two new recovery successes restore intake');
  await finishTick(failedTick,false);await finishTick(oldTick);
  check(await healthy(),'late/replayed callbacks from the old epoch cannot change restored health');
  await elapseHealthClock(admin.query.bind(admin),121);check(!(await healthy()),'stale real scheduler state closes intake');
  await finishTick(await beginTick());check(!(await healthy()),'first success after restart remains closed');
  await elapseHealthClock(admin.query.bind(admin),60);await finishTick(await beginTick());
  check(await healthy(),'restart requires two new successful requests');
  const refundJob=await create(2,'refund-only',false),refundImage=(await claim(refundJob))[0];
  const refundResults=(await Promise.all(Array.from({length:8},()=>service('select defer_analysis_image($1,$2,$3,false,0,true) state',[refundImage.id,refundImage.lease_token,'timeout'])))).flat();
  check(refundResults.filter(r=>r.state==='failed').length===1,'8 concurrent provider failures settle the job once');
  check(refundResults.filter(r=>r.state==='stale').length===7,'late failures are fenced before changing quota');
  check((await row("select image_count from usage_limits where line_user_id='refund-only'")).image_count===0,'entire unusable reservation is returned once');
  check((await row('select quota_refunded from analysis_jobs where id=$1',[refundJob])).quota_refunded===2,'refund ledger equals original reservation');
  const replay=(await Promise.all(Array.from({length:8},()=>service('select release_analysis_job_quota($1) n',[refundJob])))).flat();
  check(replay.every(r=>r.n===0),'8 concurrent refund replays return no extra quota');
  await service('select clear_analysis_provider_block()');
  const raceJob=await create(1,'refund-only',false),raceImage=(await claim(raceJob))[0];
  const race=await Promise.allSettled([
    service('select complete_analysis_image($1,$2,$3) ok',[raceImage.id,raceImage.lease_token,payload]),
    service("select defer_analysis_image($1,$2,'timeout',false,0,true) state",[raceImage.id,raceImage.lease_token]),
  ]);
  check(race.every(r=>r.status==='fulfilled'),'completion and quota failure settlement do not deadlock');
  const raceState=await row('select j.status,j.quota_refunded,i.status image_status from analysis_jobs j join analysis_job_images i on i.job_id=j.id where j.id=$1',[raceJob]);
  check((raceState.image_status==='done'&&raceState.quota_refunded===0)||(raceState.status==='failed'&&raceState.quota_refunded===1),'race chooses success or refund, never both');
  const coreChecks=checks;
  await admin.query(fs.readFileSync('supabase/migrations/20261102210736_signed_scheduler_dispatches.sql','utf8'));
  await admin.query(fs.readFileSync('supabase/migrations/20261102213147_scheduler_transport_health.sql','utf8'));
  await admin.query(fs.readFileSync('supabase/migrations/20261103070253_interactive_execution_policy.sql','utf8'));
  await admin.query(fs.readFileSync('supabase/migrations/20261103073534_secret_free_wake_permits.sql','utf8'));
  await admin.query(fs.readFileSync('supabase/migrations/20261103074834_durable_job_recovery_metadata.sql','utf8'));
  await admin.query(fs.readFileSync('supabase/migrations/20261103083839_wake_lock_and_clock_order.sql','utf8'));
  const dispatchId=(await row('select gen_random_uuid() id')).id,now=(await row('select floor(extract(epoch from now()))::bigint n')).n;
  const consumed=(await Promise.all(Array.from({length:8},()=>service('select claim_analysis_dispatch($1,$2,$3) ok',[dispatchId,now,Number(now)+120])))).flat();
  check(consumed.filter(r=>r.ok).length===1,'8 signed request replays consume the nonce once');
  check((await service('select claim_analysis_dispatch(gen_random_uuid(),$1,$2) ok',[Number(now)-121,Number(now)-1]))[0].ok===false,'expired signed requests cannot be consumed');
  await admin.query(`create schema extensions;create extension pgcrypto with schema extensions;
    create schema vault;create table vault.test_keys(id uuid primary key,value text);create view vault.decrypted_secrets as select id,value decrypted_secret from vault.test_keys;create table vault.secrets(id uuid);
    create schema net;create table net.fixture_requests(id bigserial primary key,url text,headers jsonb,timeout_milliseconds integer);
    create table net.http_request_queue(id bigint);
    create table net._http_response(id bigint,status_code integer,content_type text,headers jsonb,content text,timed_out boolean,error_msg text,created timestamptz default now());
    create function net.http_get(url text,params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint language sql as $$insert into net.fixture_requests(url,headers,timeout_milliseconds) values($1,$3,$4) returning id$$;`);
  await admin.query(fs.readFileSync('ops/cron/supabase-dispatch.example.sql','utf8'));
  for(const origin of ['http://worker.example.test','https://worker.example.test/path','https://worker.example.test?query=1','https://worker.example.test:0','https://worker.example.test:65536']){
    await assert.rejects(admin.query('update sokupa_ops.scheduler_config set origin=$1',[origin]),/scheduler_config_origin_check/);checks++;
  }
  await admin.query('begin');await admin.query("update sokupa_ops.scheduler_config set origin='https://worker.example.test:18443'");
  check((await row('select origin from sokupa_ops.scheduler_config')).origin==='https://worker.example.test:18443','fixed HTTPS origin accepts an explicit valid non-root test port');
  await admin.query('rollback');
  check((await row('select sokupa_ops.enqueue_dispatch() id')).id===null,'candidate scheduler starts disabled');
  check((await row('select sokupa_ops.extensions_private() ok')).ok,'candidate checks private extension tables before activation');
  await admin.query('grant select on net.http_request_queue to public');
  await assert.rejects(admin.query('update sokupa_ops.scheduler_config set enabled=true'),/scheduler_extension_permissions_open/);checks++;
  await admin.query('revoke select on net.http_request_queue from public');
  await service('select clear_analysis_provider_block()');await primeWorkerHealth(admin.query.bind(admin));
  check((await row('select analysis_background_ready() ready')).ready,'control: fresh worker health is ready before selecting transport');
  const fixtureKey='synthetic-fixture-only-key-00000000000000',keyId=(await row('insert into vault.test_keys values(gen_random_uuid(),$1) returning id',[fixtureKey])).id;
  await admin.query("update sokupa_ops.scheduler_config set enabled=true,origin='https://worker.example.test:443',secret_id=$1",[keyId]);
  check(!(await row('select analysis_background_ready() ready')).ready,'selecting transport closes intake until proved HTTP successes');
  let requestId=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
  const sent=await row('select * from net.fixture_requests where id=$1',[requestId]),headers=sent.headers;
  const canonical=['SOKUPA-DISPATCH-V1','GET','https://worker.example.test','/api/analysis-jobs/process',headers['x-sokupa-dispatch-id'],headers['x-sokupa-issued-at'],headers['x-sokupa-expires-at']].join('\n');
  check(headers['x-sokupa-signature']===createHmac('sha256',fixtureKey).update(canonical).digest('hex'),'Postgres HMAC matches independent Node verification');
  check(sent.url==='https://worker.example.test/api/analysis-jobs/process','SQL normalizes the explicit default port in both the signed origin and request URL');
  check(!JSON.stringify(headers).includes(fixtureKey),'only a scoped short-lived signature enters the HTTP queue');
  check(sent.timeout_milliseconds===310000,'candidate explicitly bounds the HTTP timeout');
  const enqueue=(await Promise.all(Array.from({length:8},()=>pool.query('select sokupa_ops.enqueue_dispatch() id')))).flatMap(r=>r.rows);
  check(enqueue.every(r=>r.id===null),'same-minute scheduler duplicates cannot enqueue twice');
  const prove=async(request)=>{
    const h=(await row('select headers from net.fixture_requests where id=$1',[request])).headers;
    check((await service('select claim_analysis_dispatch($1,$2,$3) ok',[h['x-sokupa-dispatch-id'],h['x-sokupa-issued-at'],h['x-sokupa-expires-at']]))[0].ok,'signed nonce is claimed once');
    const tick=(await service('select begin_signed_analysis_worker_tick($1) id',[h['x-sokupa-dispatch-id']]))[0].id;
    check(Boolean(tick),'worker tick is linked to the real dispatch ID');await service('select analysis_worker_tick_complete($1,true)',[tick]);
    const ticks=(await row('select count(*)::int n from analysis_worker_ticks')).n;
    // Match pg_net 0.20's transaction timestamp: created precedes the worker completion.
    await admin.query("insert into net._http_response(id,status_code,content_type,content,created)select $1,200,'application/json',$2,enqueued_at from analysis_scheduler_transport_attempts where id=$3",[request,JSON.stringify({processed:0,processing_enabled:false,dispatch_id:h['x-sokupa-dispatch-id'],worker_tick_id:tick}),h['x-sokupa-dispatch-id']]);
    await admin.query('select sokupa_ops.reconcile_dispatches()');
    check((await row('select count(*)::int n from analysis_worker_ticks')).n===ticks,'observer does not manufacture worker success');
    return {id:h['x-sokupa-dispatch-id'],tick};
  };
  await prove(requestId);check((await row('select status from sokupa_ops.dispatches')).status==='succeeded','expected response and matching DB tick verify transport success');
  check((await row('select r.created<w.finished_at earlier from net._http_response r join sokupa_ops.dispatches d on d.request_id=r.id join analysis_scheduler_dispatches n on n.id=d.id join analysis_worker_ticks w on w.id=n.worker_tick_id where r.id=$1',[requestId])).earlier,'pg_net batch-start timestamp is not treated as HTTP completion');
  check(!(await row('select analysis_background_ready() ready')).ready,'one successful transport response does not open intake');
  const warm=async()=>{
    await admin.query('select configure_analysis_transport(true)');await admin.query('delete from sokupa_ops.dispatches');
    await prove((await row('select sokupa_ops.enqueue_dispatch() id')).id);
    check(!(await row('select analysis_background_ready() ready')).ready,'first new response remains closed');
    await elapseTransportClock(admin.query.bind(admin),60);await admin.query('delete from sokupa_ops.dispatches');
    await prove((await row('select sokupa_ops.enqueue_dispatch() id')).id);
    check((await row('select analysis_background_ready() ready')).ready,'two fresh verified transport responses restore intake');
  };
  await warm();
  const reused=(await row('select request_id from sokupa_ops.dispatches order by slot desc limit 1')).request_id;
  await admin.query("update sokupa_ops.dispatches set slot=slot-interval '2 minutes';delete from net.fixture_requests;delete from net._http_response");
  await admin.query("select setval(pg_get_serial_sequence('net.fixture_requests','id'),$1,false)",[reused]);
  const reusedRequest=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
  check(reusedRequest===reused,'a restarted pg_net sequence may reuse an old request ID');
  check((await row('select count(*)::int n from sokupa_ops.dispatches where request_id=$1',[reused])).n===2,'durable dispatch UUIDs permit request-ID reuse without enqueue failure');
  await prove(reusedRequest);
  check((await row('select status from sokupa_ops.dispatches order by slot desc limit 1')).status==='succeeded','matching nonce and actual tick select the new dispatch after request-ID reuse');
  for(const [status,type,content,timeout,error,expected] of [
    [200,'text/html','<html>Login</html>',false,null,'invalid_response'],
    [200,'application/json','{bad JSON',false,null,'invalid_response'],
    [200,'application/json','{}',false,null,'invalid_response'],
    [401,'application/json','{}',false,null,'failed'],[403,'text/html','Denied',false,null,'failed'],
    [302,'text/html','Redirect',false,null,'failed'],[503,'application/json','{}',false,null,'failed'],
    [200,'application/json','{}',true,null,'failed'],[null,null,null,false,'TLS certificate failed','failed'],
  ]){
    await warm();await admin.query('delete from sokupa_ops.dispatches');requestId=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
    await admin.query('insert into net._http_response(id,status_code,content_type,content,timed_out,error_msg)values($1,$2,$3,$4,$5,$6)',[requestId,status,type,content,timeout,error]);await admin.query('select sokupa_ops.reconcile_dispatches()');
    check((await row('select status from sokupa_ops.dispatches')).status===expected,'HTTP/TLS/HTML/redirect failure is observed');
    check(!(await row('select analysis_background_ready() ready')).ready,'transport failure closes admission despite fresh heartbeats');
    await assert.rejects(create(1,'refund-only',false),/worker_unavailable/);checks++;
  }
  await warm();await admin.query('delete from sokupa_ops.dispatches');await admin.query('select sokupa_ops.enqueue_dispatch()');await admin.query("update sokupa_ops.dispatches set response_deadline=now()-interval '1 second'");await admin.query('select sokupa_ops.reconcile_dispatches()');
  check((await row('select status from sokupa_ops.dispatches')).status==='expired','missing response expires');
  check(!(await row('select analysis_background_ready() ready')).ready,'missing-response expiry closes admission');
  await warm();await admin.query('delete from sokupa_ops.dispatches');requestId=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
  await admin.query("update sokupa_ops.dispatches set response_deadline=clock_timestamp()-interval '1 second'");
  await prove(requestId);
  check((await row('select status from sokupa_ops.dispatches')).status==='expired','a real worker proof observed after the deadline is still rejected');
  check(!(await row('select analysis_background_ready() ready')).ready,'late observation cannot restore intake');
  const stage=async(worker=true)=>{
    const d=await row('select gen_random_uuid() id,floor(extract(epoch from clock_timestamp()))::bigint iat');
    await admin.query('select begin_analysis_transport_dispatch($1,$2,$3)',[d.id,d.iat,Number(d.iat)+120]);
    let tick=null;if(worker){await service('select claim_analysis_dispatch($1,$2,$3)',[d.id,d.iat,Number(d.iat)+120]);tick=(await service('select begin_signed_analysis_worker_tick($1) id',[d.id]))[0].id;await service('select analysis_worker_tick_complete($1,true)',[tick]);}
    return {id:d.id,tick};
  };
  const record=async(d,status='succeeded')=>(await pool.query('select record_analysis_transport_result($1,$2,$3,clock_timestamp()) ok',[d.id,status,d.tick])).rows[0].ok;
  await warm();const late=await stage(),failure=await stage(false);
  await Promise.all([record(failure,'failed'),record(late)]);
  check(!(await row('select analysis_background_ready() ready')).ready,'concurrent failure and an older success always close intake');
  await record(await stage());check(!(await row('select analysis_background_ready() ready')).ready,'one recovery response cannot reuse pre-failure success');
  await elapseTransportClock(admin.query.bind(admin),60);const restored=await stage();await record(restored);
  check((await row('select analysis_background_ready() ready')).ready,'second new recovery response reopens intake');
  const currentEpoch=(await row('select epoch from analysis_scheduler_transport_state')).epoch;
  await Promise.all(Array.from({length:8},()=>record(failure,'failed')));await Promise.all(Array.from({length:8},()=>record(late)));
  check((await row('select epoch from analysis_scheduler_transport_state')).epoch===currentEpoch,'replayed old failures and late successes cannot change restored transport generation');
  const receiptsBefore=(await row("select count(*)::int n from analysis_scheduler_transport_attempts where outcome='succeeded' and epoch=$1",[currentEpoch])).n;
  await Promise.all(Array.from({length:8},()=>record(restored)));
  check((await row("select count(*)::int n from analysis_scheduler_transport_attempts where outcome='succeeded' and epoch=$1",[currentEpoch])).n===receiptsBefore,'parallel completion replays do not add success receipts');
  await warm();await admin.query('delete from sokupa_ops.dispatches');await admin.query('select sokupa_ops.enqueue_dispatch()');
  await admin.query('alter table net._http_response rename to hidden_http_response');await admin.query('select sokupa_ops.reconcile_dispatches()');
  check(!(await row('select analysis_background_ready() ready')).ready,'observer infrastructure error closes intake');
  check((await row('select failure_code from analysis_scheduler_transport_state')).failure_code==='observation_failed','observer failure persists instead of rolling back its closed gate');
  await admin.query('alter table net.hidden_http_response rename to _http_response');
  await warm();await admin.query('delete from sokupa_ops.dispatches');await admin.query('delete from vault.test_keys where id=$1',[keyId]);
  check((await row('select sokupa_ops.enqueue_dispatch() id')).id===null,'missing key enqueues no request');
  check(!(await row('select analysis_background_ready() ready')).ready,'missing key closes intake immediately');
  check((await row('select failure_code from analysis_scheduler_transport_state')).failure_code==='enqueue_failed','enqueue exception persists its failed transport state');
  await admin.query('insert into vault.test_keys values($1,$2)',[keyId,fixtureKey]);
  await warm();await admin.query('update sokupa_ops.scheduler_config set enabled=false');
  check(!(await row('select analysis_background_ready() ready')).ready,'disabled scheduler immediately closes admission');
  for(const role of ['anon','authenticated','service_role']){
    await admin.query(`set role ${role}`);await assert.rejects(admin.query('select sokupa_ops.enqueue_dispatch()'),/permission denied/);checks++;await admin.query('reset role');
  }
  await require('./wake-concurrency-checks.cjs')({admin,pool,service,elapseHealthClock});
  console.log(`PASS: ${coreChecks} real PostgreSQL 17.6 core concurrency checks; Unix socket only; synthetic data.`);
  console.log(`PASS: ${checks-coreChecks} isolated scheduler SQL/crypto checks; pg_net HTTP and Vault are synthetic fixtures, not real services.`);
 }finally{
  if(admin)await admin.query('rollback').catch(()=>{});
  if(pool)await pool.end();if(admin)await admin.end();
  if(server&&server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill('SIGKILL');}
  fs.rmSync(root,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.message);process.exitCode=1});
