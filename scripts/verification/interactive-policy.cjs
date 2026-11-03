// Actual SQL, synthetic data only. No HTTP, LINE, AI or credentials.
const{PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict');const{readFileSync}=require('node:fs');
const{setupAnalysisFixture}=require('./analysis-fixture.cjs');const{primeWorkerHealth}=require('./worker-health-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;const query=db.query.bind(db),row=async(s,a)=>(await query(s,a)).rows[0];
 const check=(v,m)=>{assert.ok(v,m);checks++;};const ready=async(mode='interactive')=>(await row('select analysis_admission_ready($1) ready',[mode])).ready;
 const create=async(user='limited',owner=false)=>(await row('select create_analysis_job($1,$2,$3,$4) id',[user,[`${user}/0.jpg`],'Synthetic',owner])).id;
 try{
  await setupAnalysisFixture(db);
  check((await row('select mode from analysis_execution_policy')).mode==='scheduled','default preserves verified scheduled mode');
  check(!(await ready()),'environment cannot select interactive mode by itself');
  check(!(await ready('scheduled')),'scheduled mode still needs real successful ticks');
  await query('grant select on users to anon');await assert.rejects(query("select set_analysis_execution_mode('interactive')"),/private_data_access_required/);checks++;
  await db.exec(readFileSync('supabase/rollout/20261102183142_restrict_private_data_access.sql','utf8'));
  await query("select set_analysis_execution_mode('interactive')");
  check(await ready(),'private explicit interactive policy accepts work without scheduler');
  check(!(await ready('scheduled')),'environment and DB policy must match');
  check((await row('select count(*)::int n from analysis_worker_ticks')).n===0,'interactive admission manufactures no scheduler ticks');
  check(!(await row('select analysis_scheduled_ready() ready')).ready,'scheduled health remains unready');
  for(const mode of ['disabled','other','',null])check(!(await ready(mode)),'unsupported or disabled client mode cannot admit work');
  await query("select register_invited_line_user('limited',null,null,'NOT-A-CODE')");
  check((await row("select invite_code from users where line_user_id='limited'")).invite_code===null,'existing user with missing invite history remains registered');
  const originalIds=(await query('select line_user_id from users order by line_user_id')).rows;
  for(const [user,owner] of [['owner',true],['unlimited',false]]){await create(user,owner);check((await row('select count(*)::int n from usage_limits where line_user_id=$1',[user])).n===0,'owner and unlimited remain quota-free');}
  await query("insert into usage_limits values('limited',to_char(now() at time zone 'Asia/Tokyo','YYYY-MM'),19,now())");
  await create();await assert.rejects(create(),/monthly_limit/);checks++;
  check((await row("select image_count from usage_limits where line_user_id='limited'")).image_count===20,'interactive keeps atomic monthly quota');
  await query("select set_analysis_execution_mode('disabled')");check(!(await ready()),'operator can stop interactive intake');
  await assert.rejects(create('owner',true),/worker_unavailable/);checks++;
  await query("select set_analysis_execution_mode('interactive')");
  await query("insert into analysis_provider_state(name,requires_admin,last_code)values('vision',true,'authentication')");
  check(!(await ready()),'provider authentication block remains effective without Cron');await assert.rejects(create('owner',true),/worker_unavailable/);checks++;
  await query('select clear_analysis_provider_block()');check(await ready(),'provider repair restores explicit interactive admission');
  await query('grant select on users to authenticated');check(!(await ready()),'opening public data closes interactive admission immediately');
  await db.exec(readFileSync('supabase/rollout/20261102183142_restrict_private_data_access.sql','utf8'));check(await ready(),'restoring private access permits the interactive path');
  await primeWorkerHealth(query);await query("select set_analysis_execution_mode('scheduled')");
  check(!(await ready('scheduled')),'mode switch cannot reuse old successful worker ticks');
  await primeWorkerHealth(query);check(await ready('scheduled'),'scheduled mode still requires its verified two-success predicate');
  check(!(await ready()),'interactive environment cannot silently use a scheduled policy');
  for(const role of ['anon','authenticated','service_role']){
   await db.exec('set role '+role);
   for(const s of ["select set_analysis_execution_mode('interactive')","update analysis_execution_policy set mode='interactive'","delete from analysis_execution_policy"]){await assert.rejects(query(s),/permission denied/);checks++;}
   if(role!=='service_role'){await assert.rejects(query("select analysis_admission_ready('interactive')"),/permission denied/);checks++;}
   await db.exec('reset role');
  }
  await assert.rejects(query("select set_analysis_execution_mode('unknown')"),/invalid_execution_mode/);checks++;
  check(JSON.stringify((await query('select line_user_id from users order by line_user_id')).rows)===JSON.stringify(originalIds),'policy changes preserve every existing user ID');
  console.log(`PASS: ${checks} interactive/scheduled policy checks; synthetic PostgreSQL only.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
