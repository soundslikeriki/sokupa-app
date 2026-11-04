// Synthetic PostgreSQL only; platform gate/invocation observations below are fixtures, not Vercel proof.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const assert=require('node:assert/strict');
const {Client}=require(process.env.PG_CLIENT_MODULE||'pg');
const bin=process.env.PG_TEST_BIN;if(!bin)throw Error('PG_TEST_BIN required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sokupa-qa-bootstrap-'));fs.chmodSync(root,0o700);
const socket=path.join(root,'socket');fs.mkdirSync(socket,{mode:0o700});
const cfg={host:socket,port:55478,user:'postgres',database:'postgres',query_timeout:10000};
let server,db,checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;};
const sql=file=>fs.readFileSync(file,'utf8');
const migrations=fs.readdirSync('supabase/migrations').filter(x=>x.startsWith('202611')).sort();
const owner='U'+'1'.repeat(32);
async function as(role,query,args){await db.query(`set role ${role}`);try{return(await db.query(query,args)).rows;}finally{await db.query('reset role');}}
async function base(){
 await db.query(`create schema storage;grant usage on schema storage,public to anon,authenticated,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,content_hash text);
 alter table storage.objects enable row level security;grant all on all tables in schema storage to service_role;`);
 await db.query(sql('ops/qa/clean-base.sql'));
 for(const m of migrations)await db.query(sql('supabase/migrations/'+m));
}
async function privateSeal(){await db.query("select set_analysis_execution_mode('disabled')");await db.query(sql('supabase/rollout/20261102183142_restrict_private_data_access.sql'));}
(async()=>{try{
 execFileSync(path.join(bin,'initdb'),['-D',path.join(root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
 server=spawn(path.join(bin,'postgres'),['-D',path.join(root,'data'),'-k',socket,'-p','55478','-c','listen_addresses='],{stdio:['ignore','ignore','pipe']});let log='';server.stderr.on('data',c=>log+=c);
 for(let i=0;i<60;i++){const c=new Client(cfg);try{await c.connect();db=c;break;}catch{await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}}
 if(!db)throw Error(log.slice(-1000));check(migrations.length===12,'twelve additive migrations');
 await db.query('create role anon;create role authenticated;create role service_role bypassrls');await base();
 check((await db.query('select count(*)::int n from users')).rows[0].n===0,'empty QA contains no user or copied source data');
 await privateSeal();check((await db.query('select legacy_job_count from analysis_legacy_cutover')).rows[0].legacy_job_count===0,'empty legacy seal');
 check((await as('service_role','select analysis_processing_secure() ok'))[0].ok,'private schema/storage/empty seal secure');
 for(const role of ['anon','authenticated'])for(const table of ['users','invite_codes','analysis_jobs','analysis_job_images','wallpapers']){await assert.rejects(as(role,`select * from ${table}`),/permission denied/);checks++;}
 await assert.rejects(db.query(sql('ops/qa/clean-base.sql')),/qa_requires_empty/);await db.query('rollback');checks++;
 await db.query(sql('ops/qa/limits.sql'));
 await db.query("insert into sokupa_qa_limits(singleton,owner_line_user_id,issued_at,expires_at)values(true,$1,clock_timestamp(),clock_timestamp()+interval '80 minutes')",[owner]);
 await db.query('insert into users(line_user_id)values($1)',[owner]);
 await db.query("select set_analysis_execution_mode('scheduled')");
 await require('./worker-health-fixture.cjs').primeWorkerHealth(db.query.bind(db));
 const create=(n=2)=>as('service_role','select create_analysis_job($1,$2,$3,true) id',[owner,Array.from({length:n},(_,i)=>`${owner}/${i}.jpg`),'Synthetic QA']);
 for(let i=0;i<8;i++)await create();
 const race=await Promise.allSettled(Array.from({length:8},async()=>{const c=new Client(cfg);try{await c.connect();await c.query('set role service_role');return await c.query('select create_analysis_job($1,$2,$3,true) id',[owner,[`${owner}/0.jpg`,`${owner}/1.jpg`],'Synthetic parallel QA']);}finally{await c.end();}}));
 check(race.filter(x=>x.status==='fulfilled').length===2,'eight independent connections reserve exactly two remaining jobs');
 check(race.filter(x=>x.status==='rejected'&&x.reason.message.includes('qa_limit_or_expiry')).length===6,'six competing jobs fail without orphan budget');
 check((await db.query('select jobs,images from sokupa_qa_limits')).rows[0].images===20,'ten jobs/twenty images reserved');
 await assert.rejects(create(),/qa_limit_or_expiry/);checks++;
 check((await db.query('select count(*)::int n from usage_limits')).rows[0].n===0,'QA resource cap does not alter unlimited-owner quota behavior');
 for(let i=0;i<40;i++)check((await as('service_role','select reserve_qa_upload($1,4) ok',[owner]))[0].ok,'bounded upload permitted');
 check(!(await as('service_role','select reserve_qa_upload(null,4) ok'))[0].ok,'null owner rejected');
 check(!(await as('service_role','select reserve_qa_upload($1,4) ok',[owner]))[0].ok,'upload forty-one rejected');
 await assert.rejects(as('service_role',"update sokupa_qa_limits set expires_at=expires_at+interval '1 minute'"),/permission denied/);checks++;
 await db.query("update sokupa_qa_limits set expires_at=clock_timestamp()-interval '1 second',issued_at=clock_timestamp()-interval '80 minutes'");
 check(!(await as('service_role','select reserve_qa_upload($1,4) ok',[owner]))[0].ok,'expired DB configuration stops uploads');
 // SQL control-flow test for TTL. These cron/network functions are explicit fixtures, not extensions.
 await db.query(`create schema cron;create table cron.job(jobid bigint,jobname text);insert into cron.job values(1,'sokupa-iphone-qa-ttl');
 create function cron.unschedule(bigint)returns boolean language sql as $$delete from cron.job where jobid=$1 returning true$$;
 create schema sokupa_wake_ops;create table sokupa_wake_ops.fixture_calls(kind text);
 create function sokupa_wake_ops.reconcile()returns void language sql as $$insert into sokupa_wake_ops.fixture_calls values('reconcile')$$;
 create function sokupa_wake_ops.enqueue()returns void language sql as $$insert into sokupa_wake_ops.fixture_calls values('enqueue')$$;`);
 await db.query(sql('ops/qa/wake-ttl.sql'));
 await db.query("update sokupa_qa_limits set issued_at=clock_timestamp(),expires_at=clock_timestamp()+interval '1 minute'");
 await db.query('select sokupa_qa_tick()');check((await db.query('select count(*)::int n from sokupa_wake_ops.fixture_calls')).rows[0].n===2,'live TTL invokes reconcile/enqueue once');
 await assert.rejects(as('service_role','select sokupa_qa_tick()'),/permission denied/);checks++;
 await db.query("update sokupa_qa_limits set issued_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()-interval '1 second'");
 await db.query('select sokupa_qa_tick()');
 check((await db.query('select mode from analysis_execution_policy')).rows[0].mode==='disabled','TTL disables admission');
 check(!(await db.query('select enabled from analysis_wake_state')).rows[0].enabled,'TTL disables wake');
 check((await db.query('select count(*)::int n from cron.job')).rows[0].n===0,'TTL removes only the named QA schedule');
 check((await db.query('select count(*)::int n from sokupa_wake_ops.fixture_calls')).rows[0].n===2,'expired TTL queues no new network request');
 // Separate logical DB models OLD worker + mutable anonymous Storage, using no real data/keys.
 await db.query('create database legacy_drain');await db.end();db=new Client({...cfg,database:'legacy_drain'});await db.connect();await base();
 await db.query('insert into users(line_user_id)values($1)',[owner]);
 await db.query(`grant insert,select on storage.objects to anon;create policy "Allow public upload to memo_uploads" on storage.objects for insert to anon with check(bucket_id='memo_uploads');update storage.buckets set public=true`);
 let stage='open',active=0,clock=0,lastAccept=0;
 const allow=(method,route)=>stage==='open'||(stage==='draining'&&method==='POST'&&route==='/api/parse-memo');
 const intake=async()=>{if(!allow('POST','/api/analysis-jobs'))return null;lastAccept=clock;active++;return(await as('service_role',"insert into analysis_jobs(line_user_id,total_images)values($1,2)returning id",[owner]))[0].id;};
 const job=await intake();check(Boolean(job),'old service ingress accepted initial job');stage='draining';
 check(await intake()===null,'gate blocks new service job intake before moving aliases');
 check(allow('POST','/api/parse-memo')&&!allow('GET','/api/parse-memo'),'old worker parse POST retained exclusively while draining');
 const canSeal=()=>stage==='closed'&&active===0&&clock-lastAccept>=360000;
 check(!canSeal(),'sealing refused while legacy invocation remains active');
 for(let idx=0;idx<2;idx++){
  check(allow('POST','/api/parse-memo'),'each accepted legacy image keeps its original parse route');
  await as('service_role',"insert into analysis_job_images(job_id,idx,url,status,parsed)values($1,$2,$3,'done',$4)",[job,idx,`${owner}/${idx}.jpg`,{items:[{product_code:'QA',total_m:20}]}]);
 }
 await as('service_role',"update analysis_jobs set status='done',done_images=2,result=$2,notification_status='accepted' where id=$1",[job,{items:[{product_code:'QA',total_m:40}]}]);active--;
 stage='closed';clock=360001;check(canSeal(),'synthetic six-minute clock plus completed invocation meets controller condition');
 const before=(await db.query('select id,status,result,notification_status from analysis_jobs')).rows;
 await as('anon',"insert into storage.objects(bucket_id,name,content_hash)values('memo_uploads','late.jpg','synthetic-sha')");
 check((await db.query('select count(*)::int n from storage.objects')).rows[0].n===1,'Vercel gate alone does not stop old anonymous Storage writes');
 await privateSeal();await assert.rejects(as('anon',"insert into storage.objects(bucket_id,name)values('memo_uploads','denied.jpg')"),/row-level security|permission denied/);checks++;
 const final=(await db.query('select id,status,result,notification_status from analysis_jobs')).rows;
 assert.deepEqual(final,before);checks++;
 check((await db.query('select count(*)::int n from storage.objects')).rows[0].n===1,'final delta preservation includes the late anonymous object');
 check((await as('service_role','select * from resumable_analysis_jobs()')).length===0,'sealed old job cannot resume or replay notifications');
 check((await db.query("select execution_mode from analysis_jobs where id=$1",[job])).rows[0].execution_mode==='legacy','completed old result preserved as legacy');
 // SQL/RLS does not close service ingress: this proof is why actual WAF/invocation checks remain mandatory.
 check((await as('service_role',"insert into analysis_jobs(line_user_id,total_images)values($1,1)returning id",[owner])).length===1,'service SQL remains writable after RLS closure, independently of fixture HTTP gate');
 console.log(JSON.stringify({checks,passed:true,syntheticOnly:true,platformGateIsFixture:true,root}));
}finally{if(db)await db.end().catch(()=>{});if(server){server.kill('SIGINT');await new Promise(r=>server.once('exit',r));}}})().catch(e=>{console.error(e);process.exitCode=1;});
