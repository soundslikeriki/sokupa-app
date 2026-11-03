// Opt-in, disposable LOCAL stack only. Real pg_cron/pg_net/Vault; synthetic application work.
// Requires explicit approval for the local stack and its test credentials. Never use production.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Client,Pool}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable stack directory required');
const start=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.DB_URL);
if(start?.runtime!=='native')throw Error('Native test stack metadata required');
const url=new URL(start.env.DB_URL);
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/postgres')throw Error('Non-local database refused');
const config={connectionString:start.env.DB_URL,ssl:false,connectionTimeoutMillis:5000,query_timeout:12000};
const db=new Client(config),pool=new Pool({...config,max:8});
let checks=0,mode='healthy',captures=0,server,raw,jobId,notifications=0,slowBatchStarted=false;const calls=[];
const originalFetch=global.fetch;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,message)=>{assert.ok(value,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const row=async(sql,args)=>(await db.query(sql,args)).rows[0];
const service=async(sql,args)=>{const c=await pool.connect();try{await c.query('set role service_role');return(await c.query(sql,args)).rows;}finally{await c.query('reset role');c.release();}};
const wait=async(fn,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(300);}throw Error('Local verification condition timed out');};
const response=async(id,timeout=15000)=>wait(async()=>row('select status_code,content_type,content,timed_out,error_msg,created from net._http_response where id=$1',[id]),timeout);
const request=async(target,headers={},timeout=1500)=>(await row('select net.http_get(url:=$1,headers:=$2,timeout_milliseconds:=$3) id',[target,headers,timeout])).id;
const ready=async()=>(await row('select analysis_background_ready() ready')).ready;
const report=stage=>console.log(JSON.stringify({stage,checks,mode,at:new Date().toISOString()}));
async function setup(){
 const existing=(await row("select to_regclass('public.users') present")).present;
 if(existing){
  check((await row("select to_regclass('public.sokupa_local_verification_only') present")).present,'only this suite may reuse its own disposable schema');
  check((await row("select count(*)::int n from users where line_user_id not in ('local-owner','local-limited')")).n===0,'no other application users in this disposable fixture');
  await db.query('delete from analysis_job_images;delete from analysis_jobs;delete from usage_limits');
  await db.query(fs.readFileSync('ops/cron/supabase-dispatch.example.sql','utf8'));return;
 }
 check(!existing,'fresh isolated app schema; existing applications refused');
 await db.query(`create table public.sokupa_local_verification_only(id text primary key);insert into public.sokupa_local_verification_only values('synthetic-only');
 create table users(line_user_id text primary key,display_name text,picture_url text,invite_code text,last_login_at timestamptz);
 create table invite_codes(code text primary key,is_used boolean,used_at timestamptz);create table unlimited_users(line_user_id text primary key);
 create table usage_limits(line_user_id text,year_month text,image_count integer,updated_at timestamptz,unique(line_user_id,year_month));
 create table analysis_jobs(id uuid primary key default gen_random_uuid(),line_user_id text,status text default 'queued',site_name text,context jsonb,total_images integer,done_images integer default 0,result jsonb,error text,updated_at timestamptz default now());
 create table analysis_job_images(id uuid primary key default gen_random_uuid(),job_id uuid references analysis_jobs(id),idx integer,url text,status text default 'queued',parsed jsonb,error text,updated_at timestamptz default now());
 insert into users(line_user_id)values('local-owner'),('local-limited');
 insert into storage.buckets(id,name,public)values('memo_uploads','memo_uploads',true);`);
 for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.startsWith('20261102')).sort())await db.query(fs.readFileSync(path.join('supabase/migrations',name),'utf8'));
 await db.query(fs.readFileSync('supabase/rollout/20261102183142_restrict_private_data_access.sql','utf8'));
 await db.query(fs.readFileSync('ops/cron/supabase-dispatch.example.sql','utf8'));
 check((await row('select analysis_processing_secure() secure')).secure,'actual stack passes the private data gate');
}
async function main(){
 await db.connect();report('connected');
 const dataDirectory=(await row("select current_setting('data_directory') data")).data;
 assert.ok(fs.realpathSync(dataDirectory).startsWith(fs.realpathSync(root)+path.sep),'database files must belong to this disposable root before any mutation');
 console.log(JSON.stringify({extensionVersions:(await db.query("select extname,extversion from pg_extension where extname in ('pg_cron','pg_net','supabase_vault','pgcrypto') order by extname")).rows}));
 check((await row("select current_setting('listen_addresses') value")).value==='','database uses only a Unix socket behind the loopback proxy');
 const keyFile=path.join(root,'dispatch-key');const key=fs.existsSync(keyFile)?fs.readFileSync(keyFile,'utf8'):crypto.randomBytes(32).toString('hex');fs.writeFileSync(keyFile,key,{mode:0o600});
 const secretId=(await row("select id from vault.secrets where name='sokupa-local-dispatch-only'"))?.id||(await row("select vault.create_secret($1,'sokupa-local-dispatch-only') id",[key])).id;
 check((await row('select exists(select 1 from vault.decrypted_secrets where id=$1 and decrypted_secret=$2) ok',[secretId,key])).ok,'real Vault decrypts the local test secret');
 check((await row('select secret<>$2 ciphertext from vault.secrets where id=$1',[secretId,key])).ciphertext,'real Vault stores ciphertext rather than plaintext');
 raw=http.createServer(async(req,res)=>{
  if(req.url==='/delay'){await sleep(500);res.end('late');return;}
  if(req.url==='/slow-batch'){slowBatchStarted=true;await sleep(125000);res.end('slow');return;}
  if(req.url==='/capture'){if(req.headers['x-sokupa-signature'])captures++;res.setHeader('Content-Type','text/html');res.end('<html>local sink</html>');return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/login'});res.end();return;}
  if(req.url==='/login'){res.setHeader('Content-Type','text/html');res.end('<html>local login</html>');return;}
  res.writeHead(Number(req.url.slice(1))||200,{'Content-Type':'application/json'});res.end('{}');
 });
 await new Promise((resolve,reject)=>{raw.once('error',reject);raw.listen(0,'127.0.0.1',resolve);});const rawOrigin=`http://127.0.0.1:${raw.address().port}`;
 check((await response(await request(rawOrigin+'/200'))).status_code===200,'real pg_net performs localhost HTTP');
 for(const status of [401,403,429,503])check((await response(await request(rawOrigin+'/'+status))).status_code===status,`real pg_net preserves HTTP ${status}`);
 const redirect=await response(await request(rawOrigin+'/redirect'));check(redirect.status_code===200&&redirect.content.includes('local login'),'real pg_net follows redirects to login HTML');
 const timeout=await response(await request(rawOrigin+'/delay',{},100));check(Boolean(timeout.timed_out||timeout.error_msg),'real pg_net records a socket timeout');
 await setup();
 const api=start.env.API_URL||Object.values(start.endpoints).flatMap(x=>Object.values(x)).find(x=>x?.protocol==='http')?.url;
 if(api){
  const localApi=new URL(api);if(!['127.0.0.1','localhost','[::1]'].includes(localApi.hostname))throw Error('Non-local API refused');
  const anon={apikey:start.env.ANON_KEY,Authorization:`Bearer ${start.env.ANON_KEY}`};
  const adminHeaders={apikey:start.env.SERVICE_ROLE_KEY,Authorization:`Bearer ${start.env.SERVICE_ROLE_KEY}`};
  const denied=await fetch(new URL('/rest/v1/users?select=line_user_id',api),{headers:anon});
  check([401,403].includes(denied.status),'real PostgREST denies anonymous access after cutover');
  const permitted=await fetch(new URL('/rest/v1/users?select=line_user_id',api),{headers:adminHeaders});
  check(permitted.status===200&&(await permitted.json()).length===2,'real PostgREST permits server access and preserves synthetic user IDs');
  const object='/storage/v1/object/memo_uploads/local-owner/synthetic.jpg';
  const uploaded=await fetch(new URL(object,api),{method:'POST',headers:{...adminHeaders,'Content-Type':'image/jpeg','x-upsert':'true'},body:Buffer.from([255,216,255,224]),redirect:'error'});
  check(uploaded.status===200,'real private Storage accepts a synthetic server upload');
  const publicRead=await fetch(new URL('/storage/v1/object/public/memo_uploads/local-owner/synthetic.jpg',api),{headers:anon});
  check(publicRead.status!==200,'real private Storage denies a public object read');
  const objectRead=await fetch(new URL(object,api),{headers:adminHeaders});
  check(objectRead.status===200&&(await objectRead.arrayBuffer()).byteLength===4,'real private Storage permits the server read');
 }else throw Error('Local REST/Storage endpoints unavailable');
 const {createClient}=require('@supabase/supabase-js');
 const admin=createClient(api,start.env.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 process.env.NEXT_PUBLIC_SUPABASE_URL=api;process.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic-local-only';
 global.fetch=async(input,init)=>{
  const target=new URL(input instanceof Request?input.url:String(input));
  if(target.hostname==='api.line.me'){assert.equal(target.pathname,'/v2/bot/message/push');notifications++;return new Response('{}',{headers:{'Content-Type':'application/json'}});}
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'unexpected external traffic blocked');
  return originalFetch(input,{...init,redirect:'error'});
 };
 const {runScheduledAnalysisBatch}=require('../../src/lib/analysis-scheduled.ts');
 const {runAnalysisJob}=require('../../src/lib/analysisJobProcessor.ts');
 process.env.ANALYSIS_DISPATCH_SECRET=key;
 let workerOrigin;
 const {verifySchedulerDispatch}=require('../../src/lib/scheduler-dispatch.ts');
 server=https.createServer({key:fs.readFileSync(path.join(root,'tls/key.pem')),cert:fs.readFileSync(path.join(root,'tls/cert.pem'))},async(req,res)=>{
  const started=Date.now();
  try{
   if(mode==='401'){res.writeHead(401);res.end();return;}
   if(mode==='redirect'){res.writeHead(302,{Location:rawOrigin+'/capture'});res.end();return;}
   const incoming=new Request(workerOrigin+req.url,{headers:req.headers,method:req.method});
   const dispatch=verifySchedulerDispatch(incoming);
   if(!dispatch){res.writeHead(403);res.end();return;}
   if(!(await service('select claim_analysis_dispatch($1,$2,$3) ok',[dispatch.id,dispatch.issuedAt,dispatch.expiresAt]))[0].ok){res.writeHead(409);res.end();return;}
   const requestMode=mode;process.env.ANALYSIS_BACKGROUND_MODE=requestMode==='images'?'scheduled':'disabled';
   const result=await runScheduledAnalysisBatch(admin,opts=>runAnalysisJob({...opts,parse:async()=>{
    await sleep(31000);return new Response(JSON.stringify({data:{items:[{product_code:'LOCAL',manufacturer:'Local',entries:[{original_formula:'2×1',length_m:2,quantity:1,subtotal_m:2}],total_m:2,order_quantity:3}]} }),{headers:{'Content-Type':'application/json'}});
   }}),dispatch.id);
   calls.push({id:dispatch.id,tick:result.worker_tick_id,mode:requestMode,started,finished:Date.now()});
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...result,dispatch_id:dispatch.id}));
  }catch(e){res.writeHead(503);res.end();console.log(JSON.stringify({worker_error_code:e.code||e.name}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 workerOrigin=`https://localhost:${server.address().port}`;process.env.ANALYSIS_DISPATCH_ORIGIN=workerOrigin;
 const tls=await response(await request(workerOrigin+'/api/analysis-jobs/process'));check(tls.status_code===403&&!tls.error_msg,'real pg_net verifies the temporary localhost TLS certificate');
 await db.query('update sokupa_ops.scheduler_config set origin=$1,secret_id=$2,expect_processing=false,enabled=true',[workerOrigin,secretId]);
 const enqueue=async()=>{await db.query('delete from sokupa_ops.dispatches');return(await row('select sokupa_ops.enqueue_dispatch() id')).id;};
 const prove=async()=>{const id=await enqueue();check(Boolean(id),'signed candidate enqueues through real Vault and pg_net');const r=await response(id,45000);await db.query('select sokupa_ops.reconcile_dispatches()');return r;};
 check((await prove()).status_code===200,'signed HTTP uses production signature verifier and real SQL worker proof');
 check(!(await ready()),'first real transport completion leaves intake closed');
 // Real cron uses wall-clock minute spacing; no clock-aging helper in this suite.
 const cronName='sokupa-local-review6';
 await db.query('delete from sokupa_ops.dispatches');
 await db.query("select cron.schedule($1,'* * * * *',$2)",[cronName,'select sokupa_ops.reconcile_dispatches();select sokupa_ops.enqueue_dispatch();']);
 report('waiting-for-two-real-cron-successes');
 await wait(async()=>{await db.query('select sokupa_ops.reconcile_dispatches()');return await ready();},190000);
 check(await ready(),'actual minute cron and two distinct real HTTP completions activate intake');
 check((await row("select count(*)::int n from cron.job_run_details where jobid=(select jobid from cron.job where jobname=$1) and status='succeeded'",[cronName])).n>=1,'pg_cron records successful real job runs');
 mode='401';await prove();check(!(await ready()),'observed real HTTP401 closes admission despite fresh worker heartbeats');
 await assert.rejects(service('select create_analysis_job($1,$2,$3,false)',['local-limited',['local-limited/0.jpg'],'Synthetic']),/worker_unavailable/);checks++;
 check((await row("select count(*)::int n from usage_limits where line_user_id='local-limited'")).n===0,'failed transport never reserves usage');
 mode='redirect';await prove();check(!(await ready()),'redirect to real HTML cannot restore admission');check(captures>0,'pg_net forwards the short-lived signature to a local redirect sink; limitation observed');
 mode='healthy';server.closeAllConnections();server.setTicketKeys(crypto.randomBytes(48));
 server.setSecureContext({key:fs.readFileSync(path.join(root,'tls/key.pem')),cert:fs.readFileSync(path.join(root,'tls/bad-cert.pem'))});
 const tlsFailed=await prove();check(Boolean(tlsFailed.error_msg),'real pg_net rejects a TLS hostname mismatch');
 check(!(await ready()),'observed real TLS failure closes admission');
 server.setSecureContext({key:fs.readFileSync(path.join(root,'tls/key.pem')),cert:fs.readFileSync(path.join(root,'tls/cert.pem'))});
 report('waiting-for-two-post-failure-cron-successes');
 await wait(async()=>{await db.query('select sokupa_ops.reconcile_dispatches()');return await ready();},190000);
 check(await ready(),'two post-failure real cron completions recover admission');
 for(const name of ['0.jpg','1.jpg']){const uploaded=await admin.storage.from('memo_uploads').upload('local-owner/'+name,Buffer.from([255,216,255,224]),{contentType:'image/jpeg',upsert:true});check(!uploaded.error,'synthetic image stored for the actual application worker');}
 jobId=(await service('select create_analysis_job($1,$2,$3,true) id',['local-owner',['local-owner/0.jpg','local-owner/1.jpg'],'Synthetic']))[0].id;
 await db.query('update sokupa_ops.scheduler_config set expect_processing=true');
 mode='images';report('waiting-for-closed-browser-two-images');
 await wait(async()=>{await db.query('select sokupa_ops.reconcile_dispatches()');return(await row('select status from analysis_jobs where id=$1',[jobId])).status==='done'&&calls.filter(c=>c.mode==='images').length>=2;},220000);
 check((await row('select done_images from analysis_jobs where id=$1',[jobId])).done_images===2,'actual cron completes two 31-second synthetic images without a browser');
 check(notifications===1,'synthetic completion notification counted once; no LINE sent');
 mode='healthy';await db.query('select cron.unschedule($1)',[cronName]);report('cron-stopped-for-expiry-test');
 const before=calls.length;const slow=await request(rawOrigin+'/slow-batch',{},130000);await wait(()=>slowBatchStarted);
 const expiredRequest=await enqueue();
 const expired=await response(expiredRequest,145000);await db.query('select sokupa_ops.reconcile_dispatches()');
 check(expired.status_code===403,'real queued request arriving after the 120-second signature deadline is rejected');
 check(calls.length===before,'expired queued request never starts an application worker');
 check(!(await ready()),'queue delay and expired authentication close admission');
 check((await response(slow,1000)).status_code===200,'slow real HTTP batch ended without artificial DB clock changes');
 check((await row("select count(*)::int n from cron.job where jobname=$1",[cronName])).n===0,'test cron removed');
 report('complete');
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({checks,calls:calls.length,notifications,redirectSignatureForwarded:captures>0,versions:(await db.query("select extname,extversion from pg_extension where extname in ('pg_cron','pg_net','supabase_vault')")).rows},null,2));
}
main().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 try{if(db._connected)await db.query("select cron.unschedule(jobid) from cron.job where jobname='sokupa-local-review6'");}catch{}
 server?.closeAllConnections();raw?.closeAllConnections();await Promise.all([new Promise(r=>server?server.close(r):r()),new Promise(r=>raw?raw.close(r):r())]);await pool.end();await db.end();
 global.fetch=originalFetch;
});
