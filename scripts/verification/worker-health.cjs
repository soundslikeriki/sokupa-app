// Real migration, synthetic health records only. The data-security predicate is isolated here;
// the full migration harness verifies its real definition and role permissions separately.
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
 const db = new PGlite(); let checks=0;
 const sql = text => db.exec(text);
 const row = async (text,args) => (await db.query(text,args)).rows[0];
 const check = (value,message) => { assert.ok(value,message); checks++; };
 const begin = async () => (await row('select analysis_worker_tick_begin() id')).id;
 const complete = async (id,success=true) => (await row('select analysis_worker_tick_complete($1,$2) ok',[id,success])).ok;
 const ready = async () => (await row('select analysis_background_ready() ready')).ready;
 // Advance the synthetic fixture's clock uniformly without waiting or changing production time.
 const elapse = seconds => sql(`update analysis_worker_ticks set started_at=started_at-interval '${seconds} seconds',finished_at=finished_at-interval '${seconds} seconds';
   update analysis_worker_state set health_reset_at=health_reset_at-interval '${seconds} seconds',last_tick_started_at=last_tick_started_at-interval '${seconds} seconds',last_started_at=last_started_at-interval '${seconds} seconds',last_success_at=last_success_at-interval '${seconds} seconds';`);
 const restart = () => sql('delete from analysis_worker_ticks; delete from analysis_worker_state;');
 try {
  await sql(`create role anon;create role authenticated;create role service_role bypassrls;
   create table analysis_worker_state(worker_name text primary key,last_started_at timestamptz not null,previous_started_at timestamptz,last_success_at timestamptz,last_error text);
   alter table analysis_worker_state enable row level security;grant all on analysis_worker_state to service_role;
   create function analysis_worker_tick_start() returns void language sql as 'select';
   create function analysis_worker_tick_finish(boolean) returns void language sql as 'select';
   create function analysis_processing_secure() returns boolean language sql as 'select true';
   create function analysis_background_ready() returns boolean language sql as 'select true';
   grant execute on function analysis_worker_tick_start(),analysis_worker_tick_finish(boolean) to service_role;
   insert into analysis_worker_state values('scheduled-v1',now(),now()-interval '1 minute',now(),null);`);
  await sql(readFileSync('supabase/migrations/20261102203127_verified_worker_success_ticks.sql','utf8'));
  check(!(await ready()),'upgrade never trusts the old start/success timestamps');
  let first=await begin(); check(!(await ready()),'a start alone is not a successful tick');
  check(await complete(first,false),'failure is recorded');
  await elapse(60); const second=await begin(); await complete(second);
  check(!(await ready()),'one failed tick plus one successful tick does not open intake');
  await elapse(60); await complete(await begin());
  check(await ready(),'two completed spaced successes after failure open intake');
  check(!(await complete(first)),'replaying success cannot rewrite an earlier failed tick');
  check(await ready(),'stale replay cannot corrupt current health');

  const oldInFlight=await begin(); const failure=await begin(); await complete(failure,false);
  check(!(await ready()),'infrastructure failure closes intake immediately');
  check(!(await complete(oldInFlight)),'late in-flight success before failure is fenced');
  await elapse(60); const recovery=await begin(); await complete(recovery);
  check(!(await ready()),'first post-failure success cannot restore intake');
  await complete(recovery); await complete(recovery);
  check(!(await ready()),'duplicate completion of one invocation never counts twice');
  await elapse(60); await complete(await begin());
  check(await ready(),'second distinct post-failure success restores intake');

  await elapse(121); check(!(await ready()),'expired scheduler activity closes intake');
  const epochBefore=(await row('select health_epoch from analysis_worker_state')).health_epoch;
  await complete(await begin());
  check((await row('select health_epoch from analysis_worker_state')).health_epoch!==epochBefore,'scheduler restart begins a fresh health epoch');
  check(!(await ready()),'first success after restart cannot reuse old success history');
  await elapse(60); await complete(await begin()); check(await ready(),'restart requires two new completed successes');

  await restart(); first=await begin(); await complete(first); await elapse(60);
  const pending=await begin(); check(!(await ready()),'an unfinished second invocation does not count');
  await complete(pending); check(await ready(),'second completion is required before admission');
  check(!(await complete(pending,false)),'contradictory replay cannot overwrite a completed outcome');
  check(await ready(),'contradictory replay cannot invalidate a recorded success');

  await restart(); first=await begin(); await elapse(60); const later=await begin();
  await complete(later); check(!(await ready()),'out-of-order completion waits for both successes');
  await complete(first); check(await ready(),'two successful overlapping invocations can finish out of order');

  await restart(); const simultaneous=await Promise.all(Array.from({length:8},()=>begin()));
  await Promise.all(simultaneous.map(id=>complete(id)));
  check(new Set(simultaneous).size===8,'each invocation has its own ID');
  check(!(await ready()),'parallel duplicate scheduler calls do not fake 30-second spacing');
  await elapse(31); await complete(await begin()); check(await ready(),'a subsequent spaced success opens intake');

  const expired=await begin(); await elapse(361);
  check(!(await complete(expired)),'a completion after six minutes cannot claim success');
  check(!(await ready()),'expired completion invalidates old health');
  check(!(await complete('00000000-0000-4000-8000-000000000000')),'unknown completion cannot record success');
  check(!(await ready()),'unknown completion leaves intake closed');

  await restart(); first=await begin(); await complete(first); await elapse(60); await complete(await begin());
  await sql("update analysis_worker_ticks set started_at=now()-interval '4 minutes' where id='"+first+"'");
  check(!(await ready()),'old first success expires even if another caller starts recently');
  await restart(); first=await begin();
  await sql("update analysis_worker_ticks set started_at=now()+interval '1 minute' where id='"+first+"'");
  check(!(await complete(first)),'future-dated start cannot complete successfully');

  for (const role of ['anon','authenticated']) {
   await sql(`set role ${role}`);
   for (const query of ['select * from analysis_worker_ticks','select analysis_worker_tick_begin()',"select analysis_worker_tick_complete('00000000-0000-4000-8000-000000000000',true)"]) {
    await assert.rejects(db.query(query),/permission denied/); checks++;
   }
   await sql('reset role');
  }
  await sql('set role service_role');
  for (const query of ['select analysis_worker_tick_start()','select analysis_worker_tick_finish(true)']) { await assert.rejects(db.query(query),/permission denied/);checks++; }
  const serviceTick=await begin(); check(await complete(serviceTick),'service role can record v2 ticks');
  await sql('reset role');
  console.log(`PASS: ${checks} worker health checks; synthetic PostgreSQL only.`);
 } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
