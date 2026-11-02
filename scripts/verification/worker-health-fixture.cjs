// Test fixtures only: age synthetic records instead of waiting for the wall clock.
async function elapseHealthClock(query, seconds) {
  await query("update public.analysis_worker_ticks set started_at=started_at-$1::interval,finished_at=finished_at-$1::interval", [`${seconds} seconds`]);
  await query("update public.analysis_worker_state set health_reset_at=health_reset_at-$1::interval,last_tick_started_at=last_tick_started_at-$1::interval,last_started_at=last_started_at-$1::interval,last_success_at=last_success_at-$1::interval", [`${seconds} seconds`]);
}
async function primeWorkerHealth(query) {
  const first=(await query('select public.analysis_worker_tick_begin() id')).rows[0].id;
  await query('select public.analysis_worker_tick_complete($1,true)',[first]);
  await elapseHealthClock(query,60);
  const second=(await query('select public.analysis_worker_tick_begin() id')).rows[0].id;
  await query('select public.analysis_worker_tick_complete($1,true)',[second]);
}
module.exports={elapseHealthClock,primeWorkerHealth};
