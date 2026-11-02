// Actual SQL and signed-worker links. No real HTTP, pg_net, Vault, or user data.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');const {setupAnalysisFixture}=require('./analysis-fixture.cjs');
const {primeWorkerHealth}=require('./worker-health-fixture.cjs');const {elapseTransportClock}=require('./transport-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;
 const query=db.query.bind(db),row=async(s,a)=>(await query(s,a)).rows[0],check=(v,m)=>{assert.ok(v,m);checks++;};
 const ready=async()=>(await row('select analysis_background_ready() ready')).ready;
 const start=async(worker=true)=>{
  const {id,iat}=await row('select gen_random_uuid() id,floor(extract(epoch from clock_timestamp()))::bigint iat');
  await query('select begin_analysis_transport_dispatch($1,$2,$3)',[id,iat,Number(iat)+120]);
  let tick=null;if(worker){check((await row('select claim_analysis_dispatch($1,$2,$3) ok',[id,iat,Number(iat)+120])).ok,'signed nonce is claimed');tick=(await row('select begin_signed_analysis_worker_tick($1) id',[id])).id;check(Boolean(tick),'only queued signed dispatch can start a real tick');}
  return {id,tick};
 };
 const finish=async(d,outcome='succeeded',overrideTick)=>{
  if(d.tick)await query('select analysis_worker_tick_complete($1,true)',[d.tick]);
  return(await row('select record_analysis_transport_result($1,$2,$3,clock_timestamp()) ok',[d.id,outcome,overrideTick??d.tick])).ok;
 };
 const warm=async()=>{await query('select configure_analysis_transport(true)');await finish(await start());await elapseTransportClock(query,60);await finish(await start());check(await ready(),'two new proved responses restore intake');};
 try{
  await setupAnalysisFixture(db);await primeWorkerHealth(query);check(await ready(),'unselected transport does not alter another configured scheduler');
  await query('select configure_analysis_transport(true)');check(!(await ready()),'activation cannot reuse old worker heartbeats');
  const first=await start();await finish(first);check(!(await ready()),'one proved transport completion is insufficient');
  await elapseTransportClock(query,60);await finish(await start());check(await ready(),'two spaced transport and worker completions open intake');
  const denied=await start(false);await finish(denied,'failed');
  check(!(await ready()),'HTTP 401 result closes intake despite fresh successful worker heartbeats');
  await primeWorkerHealth(query);check(!(await ready()),'unrelated empty worker successes cannot heal failed transport');
  const one=await start();await finish(one);check(!(await ready()),'first post-failure success leaves intake closed');
  await finish(one);check(!(await ready()),'replayed success cannot count twice');
  await elapseTransportClock(query,60);await finish(await start());check(await ready(),'second distinct post-failure success restores intake');

  const inflight=await start(),bad=await start(false);await finish(bad,'failed');await finish(inflight);
  check(!(await ready()),'late success from before an observed failure cannot heal its epoch');
  await warm();
  for(const kind of ['failed','invalid_response','expired']){
   const d=await start(false);await finish(d,kind);check(!(await ready()),`${kind}: HTTP/TLS/redirect/unknown result closes admission`);await warm();
  }
  const unproved=await start(false);await finish(unproved,'succeeded','00000000-0000-4000-8000-000000000000');
  check((await row('select outcome from analysis_scheduler_transport_attempts where id=$1',[unproved.id])).outcome==='invalid_response','200 JSON without a matching DB completion is rejected');
  check(!(await ready()),'forged worker ID cannot keep admission open');await warm();
  const other=await start(),wrong=await start(false);await query('select analysis_worker_tick_complete($1,true)',[other.tick]);await finish(wrong,'succeeded',other.tick);
  check(!(await ready()),'a different dispatch cannot borrow a real successful worker ID');
  await warm();const future=await start();await query('select analysis_worker_tick_complete($1,true)',[future.tick]);
  await query("select record_analysis_transport_result($1,'succeeded',$2,clock_timestamp()+interval '1 hour')",[future.id,future.tick]);
  check(!(await ready()),'future/late response times cannot establish success');
  await warm();await elapseTransportClock(query,121);check(!(await ready()),'scheduler silence closes intake');
  await finish(await start());check(!(await ready()),'first completion after scheduler restart cannot reuse old responses');
  await elapseTransportClock(query,60);await finish(await start());check(await ready(),'restart requires two new verified responses');
  await query('select configure_analysis_transport(false)');check(!(await ready()),'disabling a selected scheduler closes intake immediately');
  await warm();const stale=await start();await query('select configure_analysis_transport(true)');await finish(stale);
  check(!(await ready()),'configuration/key/origin change invalidates earlier in-flight results');
  await warm();await query("select fail_analysis_transport('enqueue_failed')");check(!(await ready()),'enqueue/Vault failure closes intake');
  await warm();await query("select fail_analysis_transport('observation_failed')");check(!(await ready()),'response observer failure closes intake');
  const unknown=(await row('select gen_random_uuid() id')).id;check((await row('select begin_signed_analysis_worker_tick($1) id',[unknown])).id===null,'a signature alone cannot start a nonce absent from the dispatch queue');
  for(const role of ['anon','authenticated','service_role']){
   await db.exec(`set role ${role}`);
   for(const s of ["select configure_analysis_transport(true)","select fail_analysis_transport('enqueue_failed')",`select record_analysis_transport_result('${unknown}','succeeded',null,now())`]){await assert.rejects(query(s),/permission denied/);checks++;}
   if(role!=='service_role'){await assert.rejects(query('select * from analysis_scheduler_transport_state'),/permission denied/);checks++;}
   await db.exec('reset role');
  }
  console.log(`PASS: ${checks} transport admission checks; synthetic PostgreSQL only.`);
 }finally{await db.close();}
 const upgrade=new PGlite();
 try{
  await setupAnalysisFixture(upgrade,{skipTransport:true});await primeWorkerHealth(upgrade.query.bind(upgrade));
  check((await upgrade.query('select analysis_background_ready() ready')).rows[0].ready,'old-version fixture has ready worker heartbeats');
  await upgrade.exec('create schema sokupa_ops;create table sokupa_ops.scheduler_config(enabled boolean);insert into sokupa_ops.scheduler_config values(true)');
  await upgrade.exec(readFileSync('supabase/migrations/20261102213147_scheduler_transport_health.sql','utf8'));
  check(!(await upgrade.query('select analysis_background_ready() ready')).rows[0].ready,'upgrading an active old candidate closes the gate before its template changes');
  check((await upgrade.query('select failure_code from analysis_scheduler_transport_state')).rows[0].failure_code==='template_upgrade_required','upgrade records the required template transition');
 }finally{await upgrade.close();}
 console.log(`PASS: ${checks} transport admission/upgrade checks including the prior enabled candidate.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
