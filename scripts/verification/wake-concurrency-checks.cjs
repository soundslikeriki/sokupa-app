// Runs only inside the existing disposable PostgreSQL fixture; no network or credentials.
const assert=require('node:assert/strict');
module.exports=async function verifyWakeConcurrency({admin,pool,service,elapseHealthClock}){
 let checks=0;const q=admin.query.bind(admin),row=async(s,a)=>(await q(s,a)).rows[0],check=(v,m)=>{assert.ok(v,m);checks++;};
 const root=async(s,a)=>{const c=await pool.connect();try{return(await c.query(s,a)).rows;}finally{c.release();}};
 const age=async(n=60)=>{await elapseHealthClock(q,n);await q("update analysis_wake_state set reset_at=reset_at-$1::interval,last_enqueue_at=last_enqueue_at-$1::interval,failed_at=failed_at-$1::interval",[n+' seconds']);await q("update analysis_wake_permits set issued_at=issued_at-$1::interval,expires_at=expires_at-$1::interval,claimed_at=claimed_at-$1::interval,completed_at=completed_at-$1::interval",[n+' seconds']);for(const p of(await q('select id from analysis_wake_permits order by slot')).rows)await q('update analysis_wake_permits set slot=slot-$1::interval where id=$2',[n+' seconds',p.id]);};
 const configure=async()=>{await q("select set_analysis_execution_mode('scheduled-wake');select configure_analysis_wake(true,'https://worker.example.test',true)");await age();};
 const issue=async()=>(await row('select issue_analysis_wake_permit() id')).id;
 const claim=()=>service("select * from claim_analysis_wake('https://worker.example.test',true)");
 const ready=async()=>(await row("select analysis_admission_ready('scheduled-wake') ok")).ok;
 const proof=async()=>{const id=await issue(),p=(await claim())[0];check(p?.permit_id===id,'private permit matches');check((await service('select analysis_worker_tick_complete($1,true) ok',[p.worker_tick_id]))[0].ok,'worker completion succeeds');check((await service('select complete_analysis_wake($1,$2,true) ok',[p.permit_id,p.claim_token]))[0].ok,'permit completion succeeds');await q("select observe_analysis_wake($1,'accepted')",[id]);return p;};
 const waitBlocked=async(pid)=>{for(let i=0;i<100;i++){if((await row('select wait_event_type from pg_stat_activity where pid=$1',[pid]))?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture caller did not wait for the intended lock');};

 await configure();await proof();check(!(await ready()),'first success stays closed');await age();await proof();check(await ready(),'two control successes open intake');
 await age(121);const first=await proof();const times=await row('select p.issued_at>=s.reset_at correct from analysis_wake_permits p cross join analysis_wake_state s where p.id=$1',[first.permit_id]);check(times.correct,'gap restart permit is issued after the new epoch reset');
 check(!(await ready()),'first restart success stays closed');await age();await proof();check(await ready(),'exactly two successful restart permits reopen intake');

 // All relevant wait points: worker, wake state and permit row. A pre-wait clock is never authority.
 for(const lock of ['worker','wake','permit']){
  await configure();const id=await issue();await q("update analysis_wake_permits set expires_at=clock_timestamp()+interval '1 second' where id=$1",[id]);
  const ticks=(await row('select count(*)::int n from analysis_worker_ticks')).n,locker=await pool.connect(),caller=await pool.connect();let pending;
  try{
   await locker.query('begin');await locker.query(lock==='worker'?"select 1 from analysis_worker_state where worker_name='scheduled-v1' for update":lock==='wake'?'select 1 from analysis_wake_state where singleton for update':'select 1 from analysis_wake_permits where id=$1 for update',lock==='permit'?[id]:undefined);
   const pid=(await caller.query('select pg_backend_pid() pid')).rows[0].pid;await caller.query('set role service_role');pending=caller.query("select * from claim_analysis_wake('https://worker.example.test',true)");
   await waitBlocked(pid);check((await row('select expires_at>clock_timestamp() ok from analysis_wake_permits where id=$1',[id])).ok,'claim started before expiry');
   await new Promise(r=>setTimeout(r,1250));check((await row('select expires_at<=clock_timestamp() expired from analysis_wake_permits where id=$1',[id])).expired,'permit expired during real lock wait');
   await locker.query('commit');const result=await pending;pending=null;check(result.rows.length===0,'expired permit is not claimed after '+lock+' wait');
   check((await row('select count(*)::int n from analysis_worker_ticks')).n===ticks,'expired claim creates no new worker tick');
  }finally{await locker.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await caller.query('reset role');locker.release();caller.release();}
 }

 await configure();await issue();const stopper=await pool.connect(),caller=await pool.connect();let pending;
 try{
  await stopper.query('begin');await stopper.query("set local deadlock_timeout='50ms'");await stopper.query("set local statement_timeout=3000");await stopper.query("select 1 from analysis_worker_state where worker_name='scheduled-v1' for update");
  const pid=(await caller.query('select pg_backend_pid() pid')).rows[0].pid;await caller.query('set role service_role');pending=caller.query("select * from claim_analysis_wake('https://worker.example.test',true)");await waitBlocked(pid);
  await stopper.query("select set_analysis_execution_mode('disabled')");await stopper.query('commit');const result=await pending;pending=null;
  check(result.rows.length===0,'waiting wake cannot start after operator stop');check((await row('select mode from analysis_execution_policy')).mode==='disabled','mode stop commits without 40P01 deadlock');
 }finally{await stopper.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await caller.query('reset role');stopper.release();caller.release();}

 // Completion also samples time after the global locks.
 await configure();await issue();const p=(await claim())[0];await service('select analysis_worker_tick_complete($1,true)',[p.worker_tick_id]);await age(359);
 const locker=await pool.connect(),finisher=await pool.connect();let completion;
 try{
  await locker.query('begin');await locker.query("select 1 from analysis_worker_state where worker_name='scheduled-v1' for update");const pid=(await finisher.query('select pg_backend_pid() pid')).rows[0].pid;await finisher.query('set role service_role');completion=finisher.query('select complete_analysis_wake($1,$2,true) ok',[p.permit_id,p.claim_token]);await waitBlocked(pid);await new Promise(r=>setTimeout(r,1250));await locker.query('commit');
  check(!(await completion).rows[0].ok,'completion beyond six minutes cannot succeed after waiting');completion=null;check(!(await ready()),'late completion leaves intake closed');
 }finally{await locker.query('rollback').catch(()=>{});if(completion)await completion.catch(()=>{});await finisher.query('reset role');locker.release();finisher.release();}

 // No pending permit: a public signal uses a read-only fast path instead of waiting for control locks.
 await q("select configure_analysis_wake(false,'https://worker.example.test',true)");const holder=await pool.connect();
 try{await holder.query('begin');await holder.query("select 1 from analysis_worker_state where worker_name='scheduled-v1' for update");const fast=await Promise.race([claim(),new Promise((_,reject)=>setTimeout(()=>reject(Error('negative claim blocked on control lock')),500))]);check(fast.length===0,'no-permit signal avoids control-row locks');}finally{await holder.query('rollback');holder.release();}

 await configure();const operations=[()=>root("select set_analysis_execution_mode('disabled')"),()=>root("select set_analysis_execution_mode('scheduled-wake')"),()=>root("select configure_analysis_wake(true,'https://worker.example.test',true)"),()=>root('select issue_analysis_wake_permit()'),()=>claim(),()=>root('select expire_analysis_wake_permits()'),()=>root("select fail_analysis_wake('worker_failed')"),()=>service('select analysis_worker_tick_begin()')];
 for(let i=0;i<12;i++){const results=await Promise.allSettled(operations.map(f=>f()));check(results.every(r=>r.status==='fulfilled'),'parallel configuration/claim/expiry/worker changes do not deadlock');}
 console.log(`PASS: ${checks} real PostgreSQL wake lock/clock checks; 12 mixed concurrency rounds, no 40P01.`);return checks;
};
