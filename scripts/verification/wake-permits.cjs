// Synthetic PostgreSQL only. No external service, credentials or real user records.
const{PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');const assert=require('node:assert/strict');
const{setupAnalysisFixture}=require('./analysis-fixture.cjs');const{elapseHealthClock,primeWorkerHealth}=require('./worker-health-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;const query=db.query.bind(db),row=async(s,a)=>(await query(s,a)).rows[0];
 const check=(v,m)=>{assert.ok(v,m);checks++;};
 const service=async(s,a)=>{await db.exec('set role service_role');try{return await row(s,a);}finally{await db.exec('reset role');}};
 const ready=async()=>(await service("select analysis_admission_ready('scheduled-wake') ready")).ready;
 const configure=async(expect=true)=>{await query("select set_analysis_execution_mode('scheduled-wake')");await query("select configure_analysis_wake(true,'https://worker.example.test:443',$1)",[expect]);};
 const issue=async()=>(await row('select issue_analysis_wake_permit() id')).id;
 const claim=async(enabled=true,origin='https://worker.example.test')=>service('select * from claim_analysis_wake($1,$2)',[origin,enabled]);
 const finish=async(p,success=true)=>{await service('select analysis_worker_tick_complete($1,$2)',[p.worker_tick_id,success]);return(await service('select complete_analysis_wake($1,$2,$3) ok',[p.permit_id,p.claim_token,success])).ok;};
 const observe=(id,outcome='accepted')=>query('select observe_analysis_wake($1,$2)',[id,outcome]);
 const age=async(seconds=60)=>{await elapseHealthClock(query,seconds);await query("update analysis_wake_state set reset_at=reset_at-$1::interval,last_enqueue_at=last_enqueue_at-$1::interval,failed_at=failed_at-$1::interval",[seconds+' seconds']);await query("update analysis_wake_permits set issued_at=issued_at-$1::interval,expires_at=expires_at-$1::interval,claimed_at=claimed_at-$1::interval,completed_at=completed_at-$1::interval",[seconds+' seconds']);for(const p of (await query('select id from analysis_wake_permits order by slot')).rows)await query('update analysis_wake_permits set slot=slot-$1::interval where id=$2',[seconds+' seconds',p.id]);};
 const prove=async()=>{const id=await issue(),p=await claim();check(p?.permit_id===id,'backend claims only the root permit');check(await finish(p),'private worker completes');await observe(id);return p;};
 try{
  await setupAnalysisFixture(db);const ids=(await query('select line_user_id from users order by line_user_id')).rows;
  check(!(await ready()),'migration does not enable wake intake');check(await issue()===null,'default issues no permit');
  await query("select set_analysis_execution_mode('interactive')");check(!(await row('select analysis_background_ready() ready')).ready,'interactive release path is disabled by the closed-screen requirement');
  await configure();check((await row('select origin from analysis_wake_state')).origin==='https://worker.example.test','default HTTPS port normalized');
  check(!(await ready()),'enabling requires private successes');check(!(await claim()),'public signals cannot create a permit');
  const first=await issue();check(!!first,'root can issue a permit');check(await issue()===null,'repeated root enqueue in same slot creates no extra permit');
  check(!(await claim(true,'https://wrong.example.test')),'wrong origin cannot take permit');check(!(await claim(false)),'unexpected processing mode cannot take permit');
  await observe(first);check(!(await ready()),'HTTP204 without private worker cannot open intake');
  const a=await claim();check(a.permit_id===first,'correct backend takes existing permit');check(!(await claim()),'repeated HTTP signal cannot take claimed permit');
  check(!(await service('select complete_analysis_wake($1,gen_random_uuid(),true) ok',[a.permit_id])).ok,'wrong claim token cannot complete');
  check(!(await service('select complete_analysis_wake(gen_random_uuid(),$1,true) ok',[a.claim_token])).ok,'invented permit cannot complete');
  check(await finish(a),'private completion succeeds');check(await finish(a),'same completion replay is idempotent');check(!(await ready()),'one success and replay cannot open intake');
  await age();const b=await prove();check(await ready(),'two spaced private successes plus receipts open intake');
  const count=await row('select count(*)::int n from analysis_wake_permits');check(count.n===2,'HTTP replay creates no extra root permits');
  for(const user of ['owner','unlimited']){await service('select create_analysis_job($1,$2,null,$3)',[user,[`${user}/0.jpg`],user==='owner']);check((await row('select count(*)::int n from usage_limits where line_user_id=$1',[user])).n===0,'admin and unlimited remain quota-free');}
  await query("select register_invited_line_user('limited',null,null,'NO-CODE')");check((await row("select invite_code from users where line_user_id='limited'")).invite_code===null,'missing invite history preserves existing legitimate user');
  await age();const failedTransport=await issue();await observe(failedTransport,'failed');check(!(await ready()),'observed HTTP401 closes despite previous healthy private ticks');
  await assert.rejects(service('select create_analysis_job($1,$2,null,false)',['limited',['limited/0.jpg']]),/worker_unavailable/);checks++;
  check((await row("select count(*)::int n from usage_limits where line_user_id='limited'")).n===0,'transport refusal never reserves a quota');
  await age();await prove();check(!(await ready()),'one recovery success cannot reuse earlier epoch');await age();await prove();check(await ready(),'two new successes recover');
  await observe(failedTransport,'accepted');check(await ready(),'late response cannot rewrite failure or break restored epoch');
  await service('select complete_analysis_wake($1,$2,false)',[b.permit_id,b.claim_token]);check(await ready(),'late callback from old epoch cannot close current healthy state');
  await age();const broken=await issue(),c=await claim();check(c.permit_id===broken,'new private claim is tied to its permit');
  check(!(await finish(c,false)),'worker error is recorded as failure');await observe(broken);check(!(await ready()),'HTTP success cannot heal failed worker');
  await age();await prove();check(!(await ready()),'worker recovery needs two');await age();await prove();check(await ready(),'worker recovery after two');
  await query("insert into analysis_provider_state(name,requires_admin,last_code) values('vision',true,'authentication')");check(!(await ready()),'provider failure still closes admission');await service('select clear_analysis_provider_block()');check(await ready(),'provider clearance does not discard valid independent worker proof');
  await query('grant select on users to anon');check(!(await ready()),'public data access immediately closes admission');await query('revoke select on users from anon');check(await ready(),'private access restored');
  await age(121);check(!(await ready()),'stopped scheduler expires readiness');await prove();check(!(await ready()),'restarted scheduler first success stays closed');await age();await prove();check(await ready(),'restart requires two fresh private successes');
  await age();const expires=await issue();await age(121);check(!(await claim()),'delayed HTTP cannot claim expired permit');await query('select expire_analysis_wake_permits()');check((await row('select status from analysis_wake_permits where id=$1',[expires])).status==='expired','unclaimed permit expires durably');check(!(await ready()),'missed request closes admission');
  await age();await prove();await age();await prove();check(await ready(),'fresh proof after expiry recovers');
  await age();const dying=await issue(),d=await claim();await age(361);await query('select expire_analysis_wake_permits()');check((await row('select status from analysis_wake_permits where id=$1',[dying])).status==='expired','crashed worker lease expires');check(!(await finish(d)),'stale completed worker cannot heal expired permit');check(!(await ready()),'worker crash leaves intake closed');
  await configure(false);await age();await proveWarmup();await age();await proveWarmup();check(!(await ready()),'warmup successes do not admit paid image work');
  await query("select configure_analysis_wake(false,'https://worker.example.test',false)");check(!(await ready())&&await issue()===null,'operator disable immediately closes intake and future work');
  await configure();await primeWorkerHealth(query);check(!(await ready()),'arbitrary old scheduled health cannot replace private permits');
  await configure();await age();const older=await issue();await age();const newer=await issue();
  const clumped1=await claim();check(clumped1.permit_id===older,'delayed older permit is claimed first');await finish(clumped1);await observe(older);
  const clumped2=await claim();check(clumped2.permit_id===newer,'delayed newer permit is claimed next');await finish(clumped2);await observe(newer);
  check(!(await ready()),'two root slots delivered together do not prove starts spaced by 30 seconds');
  for(const role of ['anon','authenticated','service_role']){
    await db.exec('set role '+role);
    for(const sql of ["select configure_analysis_wake(true,'https://attacker.example.test',true)",'select issue_analysis_wake_permit()',"select observe_analysis_wake(gen_random_uuid(),'accepted')",'insert into analysis_wake_permits(id)values(gen_random_uuid())',"update analysis_wake_state set enabled=true",'delete from analysis_wake_permits']){await assert.rejects(query(sql),/permission denied/);checks++;}
    if(role!=='service_role')for(const sql of ['select * from analysis_wake_permits','select * from analysis_wake_state',"select * from claim_analysis_wake('https://worker.example.test',true)","select fail_analysis_wake('worker_failed')",'select lock_analysis_wake_state()']){await assert.rejects(query(sql),/permission denied/);checks++;}
    await db.exec('reset role');
  }
  check((await row("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%wake%' and p.prosecdef")).n===0,'no security-definer privilege elevation');
  check(JSON.stringify((await query('select line_user_id from users order by line_user_id')).rows)===JSON.stringify(ids),'all original user IDs retained');
  console.log(`PASS: ${checks} private wake permit checks; synthetic PostgreSQL only.`);
  async function proveWarmup(){const id=await issue(),p=await claim(false);check(p?.permit_id===id,'warmup mode matches root configuration');check(await finish(p),'warmup private completion');await observe(id);}
 }finally{await db.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
