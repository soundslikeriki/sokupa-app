const{PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs');
const{setupAnalysisFixture}=require('./analysis-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;const q=db.query.bind(db),row=async(s,a)=>(await q(s,a)).rows[0],check=(v,m)=>{assert.ok(v,m);checks++;};
 try{
  await setupAnalysisFixture(db,{skipRecovery:true});
  const ids=[];for(const status of ['done','failed','running','queued'])ids.push((await row("insert into analysis_jobs(line_user_id,status,total_images,result)values('owner',$1,1,'{\"items\":[]}'::jsonb)returning id",[status])).id);
  await db.exec(readFileSync('supabase/migrations/20261103074834_durable_job_recovery_metadata.sql','utf8'));
  const old=(await q('select id,status,result,execution_mode,client_result_seen_at from analysis_jobs order by status')).rows;
  check(old.length===4&&ids.every(id=>old.some(j=>j.id===id)),'migration preserves all original IDs');check(old.every(j=>j.result.items.length===0),'migration preserves original results');
  check(old.filter(j=>['done','failed'].includes(j.status)).every(j=>j.client_result_seen_at),'legacy terminal jobs do not overwrite existing user drafts through automatic discovery');
  check(old.filter(j=>['running','queued'].includes(j.status)).every(j=>j.client_result_seen_at===null),'unfinished existing work remains discoverable');check(old.every(j=>j.execution_mode==='legacy'),'historical jobs do not inherit an unproven background promise');
  await q("select set_analysis_execution_mode('scheduled-wake')");
  await db.exec('set role service_role');const created=await row("insert into analysis_jobs(line_user_id,status,total_images,execution_mode)values('owner','queued',1,'interactive')returning id,execution_mode,client_result_seen_at");await db.exec('reset role');
  check(created.execution_mode==='scheduled-wake','DB stamps the accepted mode instead of trusting caller input');check(created.client_result_seen_at===null,'new jobs remain discoverable until the result is stored');
  await q("select set_analysis_execution_mode('scheduled')");check((await row('select execution_mode from analysis_jobs where id=$1',[created.id])).execution_mode==='scheduled-wake','later mode changes do not rewrite the accepted job mode');
  check((await row("select count(*)::int n from pg_indexes where indexname='analysis_jobs_owner_recovery'")).n===1,'owner recovery has an index');
  console.log(`PASS: ${checks} legacy/new recovery metadata checks; synthetic PostgreSQL only.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
