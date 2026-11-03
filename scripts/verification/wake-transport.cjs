// SQL transport boundary. pg_net is synthetic here; no HTTP, credentials or production.
const{PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs');
const{setupAnalysisFixture}=require('./analysis-fixture.cjs'),{elapseHealthClock}=require('./worker-health-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;const q=db.query.bind(db),row=async(s,a)=>(await q(s,a)).rows[0],check=(v,m)=>{assert.ok(v,m);checks++;};
 const age=async(n=60)=>{await elapseHealthClock(q,n);await q("update analysis_wake_state set reset_at=reset_at-$1::interval,last_enqueue_at=last_enqueue_at-$1::interval,failed_at=failed_at-$1::interval",[n+' seconds']);await q("update analysis_wake_permits set issued_at=issued_at-$1::interval,expires_at=expires_at-$1::interval,claimed_at=claimed_at-$1::interval,completed_at=completed_at-$1::interval",[n+' seconds']);for(const p of(await q('select id from analysis_wake_permits order by slot')).rows)await q('update analysis_wake_permits set slot=slot-$1::interval where id=$2',[n+' seconds',p.id]);await q("update sokupa_wake_ops.requests set issued_at=issued_at-$1::interval,deadline=deadline-$1::interval",[n+' seconds']);};
 const ready=async()=>(await row("select analysis_admission_ready('scheduled-wake') r")).r;
 const enqueue=async()=>(await row('select sokupa_wake_ops.enqueue() id')).id;
 const response=async(id,status=204,{content='',error=null,timedOut=false}={})=>q('insert into net._http_response values($1,$2,$3,$4,$5,clock_timestamp())',[id,status,content,timedOut,error]);
 const prove=async()=>{const id=await enqueue(),p=await row("select * from claim_analysis_wake('https://worker.example.test',true)");assert.ok(p);await q('select analysis_worker_tick_complete($1,true)',[p.worker_tick_id]);await q('select complete_analysis_wake($1,$2,true)',[p.permit_id,p.claim_token]);await response(id);await q('select sokupa_wake_ops.reconcile()');return id;};
 const recover=async()=>{await age();await prove();check(!(await ready()),'one private recovery success stays closed');await age();await prove();if(!(await ready()))console.error(JSON.stringify({state:(await q('select * from analysis_wake_state')).rows,permits:(await q('select p.slot,p.epoch,p.status,p.transport_status,p.issued_at,w.started_at,w.finished_at,w.succeeded,w.health_epoch from analysis_wake_permits p left join analysis_worker_ticks w on w.id=p.worker_tick_id order by p.issued_at desc limit 3')).rows,worker:(await q('select * from analysis_worker_state')).rows}));check(await ready(),'two private recovery successes restore intake');};
 try{
  await setupAnalysisFixture(db);
  await db.exec(`create schema net;grant usage on schema net to anon,authenticated,service_role;
    create table net.fixture_requests(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_milliseconds int);
    create table net._http_response(id bigint,status_code int,content text,timed_out boolean,error_msg text,created timestamptz);
    grant all on net.fixture_requests,net._http_response to anon,authenticated,service_role;
    create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language sql as $$insert into net.fixture_requests(url,headers,body,timeout_milliseconds)values($1,$4,$2,$5)returning id$$;`);
  await db.exec(readFileSync('ops/cron/supabase-wake.example.sql','utf8'));
  check(await enqueue()===null,'template is inactive and needs no Vault schema');
  await db.exec("select set_analysis_execution_mode('scheduled-wake');select configure_analysis_wake(true,'https://worker.example.test',true)");
  const id=await prove();check(!(await ready()),'first complete private+HTTP request stays closed');
  const sent=await row('select * from net.fixture_requests where id=$1',[id]);check(sent.url==='https://worker.example.test/api/analysis-jobs/wake','fixed URL contains no query, token or permit');check(JSON.stringify(sent.headers)==='{}'&&JSON.stringify(sent.body)==='{}','broadly readable pg_net rows contain no secret or identity');check(sent.timeout_milliseconds===10000,'wake uses a short finite HTTP timeout');
  await age();await prove();check(await ready(),'control private proof opens intake');
  for(const [status,options] of [[401,{}],[403,{}],[429,{}],[503,{}],[302,{}],[200,{content:'<html>login</html>'}],[204,{content:'forged-json'}],[null,{error:'TLS certificate failed'}],[null,{timedOut:true}],[null,{error:'connection reset'}]]){
   await age();const bad=await enqueue();await response(bad,status,options);await q('select sokupa_wake_ops.reconcile()');check(!(await ready()),'HTTP/auth/TLS/redirect/timeout failure closes prior healthy intake');await recover();
  }
  await age();await enqueue();await age(151);await q('select sokupa_wake_ops.reconcile()');check(!(await ready()),'missing response expires and closes intake');await recover();
  await q("select configure_analysis_wake(true,'https://worker.example.test',true)");await age();const fake1=await enqueue();await response(fake1);await q('select sokupa_wake_ops.reconcile()');await age();const fake2=await enqueue();await response(fake2);await q('select sokupa_wake_ops.reconcile()');check(!(await ready()),'two forged HTTP204 receipts cannot manufacture private worker success');
  await age(121);await q('select sokupa_wake_ops.reconcile()');check(!(await ready()),'unclaimed fake-ack permits eventually expire');await recover();
  await age();await enqueue();await db.exec('drop table net._http_response');await q('select sokupa_wake_ops.reconcile()');check(!(await ready()),'observation exception closes intake');
  await db.exec('create table net._http_response(id bigint,status_code int,content text,timed_out boolean,error_msg text,created timestamptz)');await recover();
  await db.exec("create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language plpgsql as $$begin raise exception 'synthetic enqueue outage';end$$;");
  await age();check(await enqueue()===null,'enqueue exception persists failure without returning a request');check(!(await ready()),'enqueue exception closes intake');
  for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);for(const sql of ['select sokupa_wake_ops.enqueue()','select sokupa_wake_ops.reconcile()','select * from sokupa_wake_ops.requests']){await assert.rejects(q(sql),/permission denied/);checks++;}await db.exec('reset role');}
  console.log(`PASS: ${checks} secret-free transport SQL checks; network/Vault mocked, broad net grants retained.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
