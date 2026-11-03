// Destructive test ONLY for the explicitly approved disposable local stack from live-local-supabase.cjs.
// Pauses/kills its verified pg_net child; PostgreSQL crash recovery must clear UNLOGGED queues.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const{Client}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-')||process.env.SOKUPA_ALLOW_LOCAL_CRASH!=='1')throw Error('Explicit disposable local crash opt-in required');
const metadata=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.DB_URL);
if(metadata?.runtime!=='native'||!['127.0.0.1','localhost','[::1]'].includes(new URL(metadata.env.DB_URL).hostname))throw Error('Non-local stack refused');
if(!fs.existsSync(path.join(root,'result.json')))throw Error('Complete the main local integration suite first');
const localAdmin=new URL(metadata.env.DB_URL);localAdmin.username='supabase_admin';localAdmin.password='';
const config={connectionString:localAdmin.toString(),ssl:false,connectionTimeoutMillis:2000,query_timeout:10000};
let checks=0,pausedPid=null,db;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,message)=>{assert.ok(value,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const row=async(sql,args)=>(await db.query(sql,args)).rows[0];
async function connect(){const c=new Client(config);c.on('error',()=>{});try{await c.connect();return c;}catch(e){await c.end().catch(()=>{});throw e;}}
(async()=>{
 db=await connect();
 check((await row("select id from public.sokupa_local_verification_only")).id==='synthetic-only','disposable fixture marker verified');
 check((await row("select count(*)::int n from cron.job where jobname='sokupa-local-review6'")).n===0,'main integration cron is no longer running');
 const data=(await row("select current_setting('data_directory') data")).data;
 check(fs.realpathSync(data).startsWith(fs.realpathSync(root)+path.sep),'cluster data directory belongs exclusively to this disposable root');
 const postmaster=Number(fs.readFileSync(path.join(data,'postmaster.pid'),'utf8').split('\n')[0]);
 const workers=(await db.query("select pid from pg_stat_activity where backend_type like 'pg_net%' and datname='postgres'")).rows;
 check(workers.length===1,'exactly one local pg_net worker selected');
 const pid=workers[0].pid,parent=Number(execFileSync('ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'}).trim());
 check(parent===postmaster&&pid!==postmaster,'target is the verified child of the disposable postmaster');
 process.kill(pid,'SIGSTOP');pausedPid=pid;
 await db.query('delete from sokupa_ops.dispatches');
 await db.query("insert into sokupa_ops.dispatches(id,slot,request_id,expires_at,response_deadline,status)values(gen_random_uuid(),date_trunc('minute',now())-interval '1 hour',1,now()-interval '1 hour',now()-interval '1 hour','succeeded')");
 const request=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
 check(Boolean(request),'signed request durably queued while its own network worker is paused');
 check((await row('select count(*)::int n from net.http_request_queue where id=$1',[request])).n===1,'real UNLOGGED request is present before the crash');
 const dispatch=(await row('select id,response_deadline from sokupa_ops.dispatches where request_id=$1',[request]));
 await db.end();db=null;process.kill(pid,'SIGKILL');pausedPid=null;
 console.log(JSON.stringify({stage:'verified-local-pgnet-crash-triggered',checks}));
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){try{db=await connect();const w=(await db.query("select pid from pg_stat_activity where backend_type like 'pg_net%' and datname='postgres' and pid<>$1",[pid])).rows;if(w.length)break;await db.end();db=null;}catch{db=null;}await sleep(500);}
 check(Boolean(db),'real PostgreSQL crash recovery starts a new network worker');
 check((await row('select count(*)::int n from net.http_request_queue where id=$1',[request])).n===0,'crash recovery clears the real UNLOGGED request queue');
 check((await row('select count(*)::int n from net._http_response where id=$1',[request])).n===0,'lost request has no fabricated HTTP success');
 check((await row('select status from sokupa_ops.dispatches where id=$1',[dispatch.id])).status==='pending','durable dispatch survives crash recovery');
 await db.query("update sokupa_ops.dispatches set slot=slot-interval '2 minutes' where id=$1",[dispatch.id]);
 const reused=(await row('select sokupa_ops.enqueue_dispatch() id')).id;
 check(Number(reused)===1,'actual UNLOGGED sequence restarts at a retained historical request ID');
 check((await row('select count(*)::int n from sokupa_ops.dispatches where request_id=1')).n===2,'reused request ID does not block post-crash enqueue');
 const key=fs.readFileSync(path.join(root,'dispatch-key'),'utf8');
 check((await row("select exists(select 1 from vault.decrypted_secrets where name='sokupa-local-dispatch-only' and decrypted_secret=$1) ok",[key])).ok,'real Vault test credential remains decryptable after crash recovery');
 check((await row('select count(*)::int n from users')).n===2,'synthetic user IDs remain intact');
 await db.query("select cron.schedule('sokupa-local-crash-observe','* * * * *','select sokupa_ops.reconcile_dispatches();')");
 console.log(JSON.stringify({stage:'waiting-for-real-450-second-response-deadline',responseDeadline:dispatch.response_deadline,checks}));
 const end=Date.now()+530000;let nextLog=Date.now()+30000;
 while(Date.now()<end){
  const state=(await row('select status from sokupa_ops.dispatches where id=$1',[dispatch.id])).status;
  if(state!=='pending')break;
  if(Date.now()>=nextLog){console.log(JSON.stringify({stage:'awaiting-real-cron-expiry',checks,at:new Date().toISOString()}));nextLog=Date.now()+30000;}
  await sleep(1000);
 }
 check((await row('select status from sokupa_ops.dispatches where id=$1',[dispatch.id])).status==='expired','actual cron observes the lost request as expired after its real deadline');
 check(!(await row('select analysis_background_ready() ready')).ready,'actual crash and missing response leave admission closed');
 check(['expired','failed'].includes((await row('select failure_code from analysis_scheduler_transport_state')).failure_code),'transport failure persists after actual crash recovery');
 await db.query("select cron.unschedule(jobid) from cron.job where jobname='sokupa-local-crash-observe'");
 check((await row("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).n===0,'all test cron jobs removed');
 fs.writeFileSync(path.join(root,'crash-result.json'),JSON.stringify({checks,unloggedQueueLost:true,durableDispatchExpired:true},null,2));
 console.log(JSON.stringify({stage:'complete',checks}));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 if(pausedPid){try{process.kill(pausedPid,'SIGCONT');}catch{}}
 if(db){try{await db.query("select cron.unschedule(jobid) from cron.job where jobname='sokupa-local-crash-observe'");}catch{}await db.end().catch(()=>{});}
});
