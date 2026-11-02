// Isolated real PostgreSQL, synthetic data only. Unix socket in a private temp dir; no TCP.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const assert=require('node:assert/strict');
const {Client,Pool}=require(process.env.PG_CLIENT_MODULE||'pg');
const {elapseHealthClock,primeWorkerHealth}=require('./worker-health-fixture.cjs');
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
  console.log(`PASS: ${checks} real PostgreSQL 17.6 multi-connection checks; Unix socket only; synthetic data.`);
 }finally{
  if(admin)await admin.query('rollback').catch(()=>{});
  if(pool)await pool.end();if(admin)await admin.end();
  if(server&&server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill('SIGKILL');}
  fs.rmSync(root,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.message);process.exitCode=1});
