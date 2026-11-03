// Real HTTP -> Next -> Supabase SDK -> PostgREST -> PostgreSQL. No AI, LINE or external network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto'), { spawn } = require('node:child_process');
const { Client } = require(process.env.PG_CLIENT_MODULE || 'pg');
const root = process.env.SOKUPA_LOCAL_STACK_ROOT, stateFile = process.env.SOKUPA_LOCAL_STATE_FILE || 'start.log';
if (!root || !path.basename(root).startsWith('sokupa-real-supabase-') || !/^[a-z0-9.-]+\.log$/.test(stateFile)) throw Error('Explicit disposable root/state required');
const state = fs.readFileSync(path.join(root, stateFile), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(row => row.env?.API_URL);
assert.equal(state.runtime, 'native');
for (const value of [state.env.API_URL, state.env.DB_URL]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
const db = new Client({ connectionString: state.env.DB_URL, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 15000 });
let child, origin, before, addedCreatedAt = false, checks = 0; const inserted = [];
const check = (value, message) => { assert.ok(value, message); console.log(JSON.stringify({ check: ++checks, message })); };
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const snapshot = async () => JSON.stringify(await rows('select row_to_json(j) row from analysis_jobs j order by id'));
const request = async (pathname, owner) => {
  const target = new URL(pathname, origin); assert.equal(target.origin, origin);
  const headers = owner ? { cookie: `${SESSION_COOKIE}=${signToken('session', owner, 3600)}` } : {};
  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  return { status: response.status, headers: response.headers, data: await response.json() };
};
process.env.SESSION_SECRET = fs.readFileSync(path.join(root, 'dispatch-key'), 'utf8');
const { signToken, SESSION_COOKIE } = require('../../src/lib/session-token.ts');
(async () => {
  try {
    await db.connect();
    assert.ok(fs.realpathSync((await rows("select current_setting('data_directory') path"))[0].path).startsWith(fs.realpathSync(root) + path.sep));
    assert.equal((await rows('select id from sokupa_local_verification_only'))[0].id, 'synthetic-only');
    check((await rows("select count(*)::int n from users where line_user_id not in ('local-owner','local-limited')"))[0].n === 0, 'only approved synthetic users exist');
    check((await rows('select count(*)::int n from cron.job'))[0].n === 0, 'no Cron jobs are active');
    before = await snapshot();
    // Earlier native fixtures predated the baseline table's created_at field. Restore their exact schema afterwards.
    if (!(await rows("select 1 from information_schema.columns where table_schema='public' and table_name='analysis_jobs' and column_name='created_at'")).length) {
      await db.query('alter table analysis_jobs add column created_at timestamptz not null default now()'); addedCreatedAt = true;
      await db.query("notify pgrst, 'reload schema'"); await new Promise(resolve => setTimeout(resolve, 600));
    }
    for (let index = 0; index < 25; index++) {
      const id = crypto.randomUUID(), owner = index === 24 ? 'local-limited' : 'local-owner'; inserted.push(id);
      await db.query("insert into analysis_jobs(id,line_user_id,status,site_name,created_at,updated_at,result,notification_status,client_result_seen_at,total_images,done_images) values($1,$2,'done','Synthetic history',$3,$3,$4,'accepted',now(),1,1)", [id, owner, '2130-01-01T00:00:00.123456+00:00', { items: [{ product_code: 'SYNTHETIC', manufacturer: 'Synthetic', entries: [], total_m: 20, order_quantity: 23 }] }]);
    }
    const log = fs.openSync(path.join(root, 'review12-history-next.log'), 'w', 0o600);
    child = spawn(process.execPath, ['scripts/verification/local-history-server.cjs'], { env: { ...process.env, SOKUPA_LOCAL_STACK_ROOT: root, SOKUPA_LOCAL_STATE_FILE: stateFile }, stdio: ['ignore', log, log] }); fs.closeSync(log);
    const end = Date.now() + 20000;
    while (!origin && Date.now() < end) {
      if (child.exitCode !== null) throw Error('Local history server exited');
      const events = fs.readFileSync(path.join(root, 'review12-history-next.log'), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      origin = events.find(row => row.local_history_next_ready)?.origin;
      if (!origin) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(origin);
    let response = await request('/api/analysis-jobs?history=1'); check(response.status === 401, 'anonymous history HTTP is rejected');
    response = await request('/api/analysis-jobs?history=1&line_user_id=local-limited', 'local-owner');
    check(response.status === 200 && response.headers.get('cache-control') === 'no-store' && response.data.data.length === 20, 'real Next returns one noncached owner page');
    check(response.data.data.every(row => inserted.slice(0, 24).includes(row.id)), 'forged owner query cannot retrieve the other user');
    check(response.data.data.every(row => row.notification_status === 'accepted'), 'remote-seen accepted results remain in history');
    const expected = (await rows("select id from analysis_jobs where line_user_id='local-owner' and status='done' order by created_at desc,id desc")).map(row => row.id);
    const actual = response.data.data.map(row => row.id); let next = response.data.next_before, pages = 1;
    while (next) {
      assert.ok(pages < 10); response = await request('/api/analysis-jobs?history=1&before=' + next, 'local-owner'); assert.equal(response.status, 200);
      actual.push(...response.data.data.map(row => row.id)); next = response.data.next_before; pages++;
    }
    check(pages >= 2 && JSON.stringify(actual) === JSON.stringify(expected) && new Set(actual).size === actual.length, 'microsecond-identical timestamps page without lost or duplicate rows');
    response = await request('/api/analysis-jobs?history=1&before=' + inserted[24], 'local-owner'); check(response.status === 404, 'another owner cursor is rejected by real REST');
    response = await request('/api/analysis-jobs/' + inserted[24], 'local-owner'); check(response.status === 404, 'another owner result cannot be opened');
    response = await request('/api/analysis-jobs/' + inserted[0], 'local-owner'); check(response.status === 200 && response.data.data.result.items[0].product_code === 'SYNTHETIC', 'selected owned historical result is readable');
    response = await request('/api/analysis-jobs?history=1&before=invalid', 'local-owner'); check(response.status === 400, 'invalid history cursor is rejected');
    check((await rows('select count(*)::int n from cron.job'))[0].n === 0, 'history reads do not activate background processing');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (before !== undefined) {
      await db.query('delete from analysis_jobs where id=any($1::uuid[])', [inserted]);
      if (addedCreatedAt) { await db.query('alter table analysis_jobs drop column created_at'); await db.query("notify pgrst, 'reload schema'"); }

      check(await snapshot() === before, 'all fixture jobs removed and every preexisting job row unchanged');
    }
    await db.end();
  }
  console.log(JSON.stringify({ checks, realAiCalls: 0, realLineSends: 0, externalRequests: 0, nextStopped: true, fixtureRowsRemoved: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
