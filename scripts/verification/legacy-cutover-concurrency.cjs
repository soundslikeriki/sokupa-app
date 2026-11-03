// Two real connections verify that Phase 2 waits for worker state before locking jobs.
const fs = require('node:fs');
const assert = require('node:assert/strict');

module.exports = async ({ admin, pool }) => {
  await admin.query(fs.readFileSync('supabase/migrations/20261103131038_require_explicit_restart_for_legacy_jobs.sql', 'utf8'));
  await admin.query("select set_analysis_execution_mode('disabled')");
  const before = (await admin.query('select id,status,result,done_images from analysis_jobs order by id')).rows;
  const holder = await pool.connect(), cutover = await pool.connect();
  let pending;
  try {
    const pid = (await cutover.query('select pg_backend_pid() pid')).rows[0].pid;
    await holder.query('begin');
    await holder.query('select lock_analysis_wake_state()');
    // Attach a rejection handler immediately; retain the original result for the final await.
    pending = cutover.query(fs.readFileSync('supabase/rollout/20261102183142_restrict_private_data_access.sql', 'utf8'));
    pending.catch(() => {});
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = (await admin.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting === true;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(blocked, 'Phase 2 waits for the running worker');
    await holder.query("insert into analysis_jobs(line_user_id,status,total_images) values('owner','queued',1)");
    await holder.query('rollback');
    await pending;
    assert.deepEqual((await admin.query('select id,status,result,done_images from analysis_jobs order by id')).rows, before);
    assert.equal((await admin.query('select count(*)::int n from resumable_analysis_jobs()')).rows[0].n, 0);
    assert.equal((await admin.query('select analysis_processing_secure() secure')).rows[0].secure, true);
    console.log('PASS: 4 real PostgreSQL legacy cutover checks; worker/table lock order, preserved records, sealed legacy work and private access.');
  } finally {
    await holder.query('rollback').catch(() => {});
    if (pending) await pending.catch(() => {});
    await cutover.query('rollback').catch(() => {});
    holder.release(); cutover.release();
  }
};
