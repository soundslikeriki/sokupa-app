// Actual SQL, synthetic rows only. No network, provider keys, LINE, or production data.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict');
const {primeWorkerHealth}=require('./worker-health-fixture.cjs');
(async()=>{const db=new PGlite();let checks=0;
 const query=db.query.bind(db),row=async(s,a)=>(await query(s,a)).rows[0],check=(v,m)=>{assert.ok(v,m);checks++;};
 const clear=()=>query('select clear_analysis_provider_block()');
 const count=async(user='limited',month)=>(await row('select coalesce(sum(image_count),0)::int n from usage_limits where line_user_id=$1 and ($2::text is null or year_month=$2)',[user,month??null])).n;
 const create=async(n=1,user='limited',owner=false)=>(await row('select create_analysis_job($1,$2,$3,$4) id',[user,Array.from({length:n},(_,i)=>`${user}/${i}.jpg`),'Synthetic',owner])).id;
 const claim=async(id)=>(await query('select * from claim_analysis_image($1)',[id])).rows;
 const defer=async(img,code='upstream_unavailable',retry=true,delay=0,unknown=false)=>(await row('select defer_analysis_image($1,$2,$3,$4,$5,$6) state',[img.id,img.lease_token,code,retry,delay,unknown])).state;
 const advance=async(id)=>{await query("update analysis_job_images set recovery_not_before=now()-interval '1 second' where job_id=$1",[id]);await query("update analysis_provider_state set blocked_until=now()-interval '1 second' where name='vision'");};
 try{
 await require('./analysis-fixture.cjs').setupAnalysisFixture(db);
 await primeWorkerHealth(query);
 const id=await create(2);const original=(await query('select id from analysis_job_images where job_id=$1 order by idx',[id])).rows;
 let img=(await claim(id))[0];check(await count()===2,'quota reserved once for two images');
 await query('select setseed(0.56)'); // The reported zero-jitter case, with delayed observation below.
 check(await defer(img)==='queued','503 defers instead of terminal content failure');
 check((await row('select status from analysis_jobs where id=$1',[id])).status==='running','job stays resumable');
 check(await count()===2,'retry does not spend or refund the reservation');
 await new Promise(resolve=>setTimeout(resolve,25));
 const delay=(await row('select extract(epoch from recovery_not_before-updated_at) seconds from analysis_job_images where id=$1',[img.id])).seconds;
 check(delay>=60&&delay<=75,'first retry uses 60-second backoff with bounded jitter');
 check((await claim(id)).length===0,'provider cooldown cannot be bypassed by another claim');
 check(!(await row('select analysis_background_ready() ready')).ready,'cooldown closes new intake');
 await advance(id);img=(await claim(id))[0];check(img.attempt_count===2,'second claim reuses image with one increment');
 check(await defer(img,'rate_limit',true,300)==='queued','429 is retried under the same reservation');
 const retryAfter=(await row('select extract(epoch from recovery_not_before-updated_at) seconds from analysis_job_images where id=$1',[img.id])).seconds;
 check(retryAfter>=300&&retryAfter<=315,'provider retry delay is respected');
 await advance(id);img=(await claim(id))[0];check(img.attempt_count===3,'third and final attempt is bounded');
 check(await defer(img)==='failed','third provider failure stops automatic retries');
 check(await count()===0,'terminal infrastructure failure returns the entire unusable job reservation');
 check((await row('select quota_refunded from analysis_jobs where id=$1',[id])).quota_refunded===2,'refund amount is recorded');
 check(await defer(img)==='stale','late/replayed failure is fenced');
 check((await row('select release_analysis_job_quota($1) n',[id])).n===0,'explicit repeated refund is idempotent');
 check(await count()===0,'replayed refund does not reduce another reservation');
 check(JSON.stringify((await query('select id from analysis_job_images where job_id=$1 order by idx',[id])).rows)===JSON.stringify(original),'retry/refund preserves existing image IDs');

 await clear();const authJob=await create();const authImg=(await claim(authJob))[0];
 check(await defer(authImg,'authentication',false)==='failed','authentication failure is not retried');
 check(await count()===0,'authentication failure releases new quota');
 await primeWorkerHealth(query);check(!(await row('select analysis_background_ready() ready')).ready,'healthy empty ticks cannot clear an authentication block');
 await assert.rejects(create(),/worker_unavailable/);checks++;
 check((await row('select requires_admin from analysis_provider_state')).requires_admin,'configuration repair needs explicit operator action');
 await clear();check((await row('select analysis_background_ready() ready')).ready,'operator clears provider block after repair');
 for(const code of ['network','timeout']){
  const job=await create(),lease=(await claim(job))[0];
  check(await defer(lease,code,false,0,true)==='failed',`${code} unknown delivery never retries automatically`);
  check((await row('select failure_delivery_unknown from analysis_job_images where id=$1',[lease.id])).failure_delivery_unknown,'unknown delivery is retained');
  check(await count()===0,'unknown delivery failure returns quota');await clear();
 }
 const interrupted=await create(),oldLease=(await claim(interrupted))[0];
 await query("update analysis_job_images set attempt_count=3,lease_expires_at=now()-interval '1 second' where id=$1",[oldLease.id]);
 check((await claim(interrupted)).length===0,'interruption cap stops work');
 check((await row('select failure_kind from analysis_jobs where id=$1',[interrupted])).failure_kind==='infrastructure','interruption cap is infrastructure failure');
 check(await count()===0,'interruption cap also returns tracked quota');
 check(!(await row('select complete_analysis_image($1,$2,$3) ok',[oldLease.id,oldLease.lease_token,{items:[{product_code:'Synthetic'}]}])).ok,'late success cannot revive a refunded job');

 const success=await create();img=(await claim(success))[0];await defer(img);await advance(success);img=(await claim(success))[0];
 check((await row('select complete_analysis_image($1,$2,$3) ok',[img.id,img.lease_token,{items:[{product_code:'Synthetic'}]}])).ok,'a retried image can succeed');
 check(await count()===1,'successful retry uses exactly one image of quota');
 await query("update analysis_jobs set status='done' where id=$1",[success]);
 const oldMonth='2020-01',monthJob=await create();img=(await claim(monthJob))[0];
 await query('update usage_limits set year_month=$1 where line_user_id=$2',[oldMonth,'limited']);
 await query('update analysis_jobs set quota_month=$1 where id=$2',[oldMonth,monthJob]);
 await query("insert into usage_limits values('limited',to_char(now() at time zone 'Asia/Tokyo','YYYY-MM'),5,now())");
 await defer(img,'timeout',false,0,true);
 check(await count('limited',oldMonth)===1,'refund uses the original reservation month');
 check(await count('limited',(await row("select to_char(now() at time zone 'Asia/Tokyo','YYYY-MM') m")).m)===5,'new month quota remains unchanged');await clear();

 const legacy=(await row("insert into analysis_jobs(line_user_id,total_images) values('limited',1) returning id")).id;
 await query("insert into analysis_job_images(job_id,idx,url,recovery_not_before)values($1,0,'limited/legacy.jpg',now())",[legacy]);
 img=(await claim(legacy))[0];const before=await count();await defer(img,'network',false,0,true);
 check(await count()===before,'legacy jobs without proof of reservation are never guessed/refunded');await clear();
 for(const [user,owner] of [['owner',true],['unlimited',false]]){
  const job=await create(1,user,owner),lease=(await claim(job))[0];await defer(lease,'timeout',false,0,true);
  check(await count(user)===0,`${user} never acquires or refunds monthly quota`);await clear();
 }
 const missing=await create(1,'missing-ledger'),lease=(await claim(missing))[0];
 await query("delete from usage_limits where line_user_id='missing-ledger'");
 await assert.rejects(defer(lease,'timeout',false,0,true),/quota_reservation_missing/);checks++;
 check((await row('select status from analysis_job_images where id=$1',[lease.id])).status==='running','failed settlement rolls back image failure and refund together');
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  for(const s of ['select * from analysis_provider_state','select clear_analysis_provider_block()',`select release_analysis_job_quota('${id}')`,`select defer_analysis_image('${img.id}','${img.lease_token}','timeout',false,0,true)`]){await assert.rejects(query(s),/permission denied/);checks++;}
  await db.exec('reset role');
 }
 console.log(`PASS: ${checks} provider retry/quota checks; synthetic PostgreSQL only.`);
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
