// Local synthetic application backup, including policy/ops schemas and every Storage object's bytes.
// Uses only the already-approved disposable native stack; never reads hosted secrets/data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process'),{Client}=require(process.env.PG_CLIENT_MODULE||'pg'),{createClient}=require('@supabase/supabase-js');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable root required');
const start=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.DB_URL);
assert.equal(start?.runtime,'native');for(const u of [start.env.DB_URL,start.env.API_URL])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(u).hostname));
const url=new URL(start.env.DB_URL);url.username='supabase_admin';url.password='';
const source=new Client({connectionString:String(url),ssl:false}),name='sokupa_complete_restore_'+Date.now(),bucket='sokupa-restore-'+Date.now();
let target,created=false,bucketCreated=false,checks=0,schemas;const restoredPaths=[];const sdk=createClient(start.env.API_URL,start.env.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const check=(v,message)=>{assert.ok(v,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const quote=s=>'"'+s.replaceAll('"','""')+'"',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function snapshot(db){
 const rows={};for(const t of(await db.query("select schemaname,tablename from pg_tables where schemaname=any($1) order by 1,2",[schemas])).rows){
  const data=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) data from ${quote(t.schemaname)}.${quote(t.tablename)} t`)).rows[0].data;rows[t.schemaname+'.'+t.tablename]={count:data.length,sha256:sha(JSON.stringify(data))};
 }
 const privacy=(await db.query("select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,coalesce(c.relacl,acldefault('r',c.relowner))::text as relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1) and c.relkind='r' order by 1,2",[schemas])).rows;
 const columns=(await db.query("select n.nspname,c.relname,a.attname,a.attacl::text from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1) and c.relkind='r' and a.attnum>0 and not a.attisdropped order by 1,2,3",[schemas])).rows;
 const policies=(await db.query('select * from pg_policies where schemaname=any($1) order by schemaname,tablename,policyname',[schemas])).rows;
 const functions=(await db.query("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,coalesce(p.proacl,acldefault('f',p.proowner))::text as proacl,pg_get_functiondef(p.oid) body from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=any($1) and p.prokind='f' order by 1,2,3",[schemas])).rows;
 const acl=v=>v==null?v:v.slice(1,-1).split(',').sort().join(',');
 privacy.forEach(r=>r.relacl=acl(r.relacl));columns.forEach(r=>r.attacl=acl(r.attacl));functions.forEach(r=>r.proacl=acl(r.proacl));
 return{rows,privacy,columns,policies,functionHash:sha(JSON.stringify(functions))};
}
(async()=>{
 await source.connect();const directory=(await source.query("select current_setting('data_directory') d")).rows[0].d;
 check(fs.realpathSync(directory).startsWith(fs.realpathSync(root)+path.sep),'backup source belongs to the disposable local cluster');
 check((await source.query('select id from sokupa_local_verification_only')).rows[0].id==='synthetic-only','synthetic data marker verified');
 check((await source.query("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).rows[0].n===0,'verification Cron is stopped before backup');
 if(!(await source.query("select 1 from information_schema.columns where table_schema='public' and table_name='analysis_jobs' and column_name='execution_mode'")).rowCount)await source.query(fs.readFileSync('supabase/migrations/20261103074834_durable_job_recovery_metadata.sql','utf8'));
 schemas=(await source.query("select nspname from pg_namespace where nspname in ('public','sokupa_ops','sokupa_wake_ops','supabase_migrations') order by nspname")).rows.map(x=>x.nspname);
 check(schemas.includes('public')&&schemas.includes('sokupa_wake_ops'),'all application/operational schemas are included');
 const before=await snapshot(source);check(Object.keys(before.rows).includes('public.analysis_execution_policy')&&Object.keys(before.rows).includes('public.analysis_wake_permits'),'execution policy and private permits are included in the archive snapshot');
 const dir=path.join(root,'complete-backup');fs.mkdirSync(dir,{mode:0o700,recursive:true});fs.mkdirSync(path.join(dir,'objects'),{mode:0o700,recursive:true});
 const storage=(await source.query("select (select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from storage.buckets b) buckets,(select coalesce(jsonb_agg(to_jsonb(o) order by o.bucket_id,o.name),'[]') from storage.objects o) objects")).rows[0];
 const manifest={buckets:storage.buckets,objects:[]};
 for(const object of storage.objects){
  const{data,error}=await sdk.storage.from(object.bucket_id).download(object.name);if(error)throw Error('Source Storage download failed');const bytes=Buffer.from(await data.arrayBuffer()),hash=sha(bytes),file=path.join(dir,'objects',hash+'.bin');fs.writeFileSync(file,bytes,{mode:0o600});
  manifest.objects.push({metadata:object,sha256:hash,bytes:bytes.length,file:'objects/'+hash+'.bin'});
 }
 check(manifest.objects.length===storage.objects.length&&manifest.objects.length>0,'every real local Storage object is exported with metadata and SHA256');
 fs.writeFileSync(path.join(dir,'storage-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 const entries=fs.readdirSync(path.join(root,'state/cache/stack/slim-services/postgres'),{recursive:true});const entry=entries.find(x=>String(x).endsWith('/bin/pg_dump'));if(!entry)throw Error('Official isolated pg_dump absent');const bin=path.dirname(path.join(root,'state/cache/stack/slim-services/postgres',entry));
 const env={PATH:process.env.PATH,PGHOST:url.hostname,PGPORT:url.port,PGUSER:'supabase_admin',PGDATABASE:'postgres'},archive=path.join(dir,'application.dump');fs.closeSync(fs.openSync(archive,'w',0o600));
 execFileSync(path.join(bin,'pg_dump'),['--format=custom',...schemas.flatMap(s=>['--schema',s]),'--file',archive],{env,stdio:'pipe',timeout:30000});
 check(fs.statSync(archive).size>0,'real pg_dump includes application and scheduler schemas');
 assert.match(name,/^sokupa_complete_restore_\d+$/);await source.query('create database '+quote(name));created=true;
 execFileSync(path.join(bin,'pg_restore'),['--clean','--if-exists','--exit-on-error','--dbname',name,archive],{env,stdio:'pipe',timeout:30000});
 const targetUrl=new URL(url);targetUrl.pathname='/'+name;target=new Client({connectionString:String(targetUrl),ssl:false});await target.connect();const after=await snapshot(target);
 check(JSON.stringify(after.rows)===JSON.stringify(before.rows),'all application rows, policy, IDs, notification state and permits restore exactly');
 if(JSON.stringify(after.privacy)!==JSON.stringify(before.privacy)||JSON.stringify(after.columns)!==JSON.stringify(before.columns))fs.writeFileSync(path.join(root,'backup-acl-difference.json'),JSON.stringify({before:{privacy:before.privacy,columns:before.columns},after:{privacy:after.privacy,columns:after.columns}},null,2),{mode:0o600});
 check(JSON.stringify(after.privacy)===JSON.stringify(before.privacy)&&JSON.stringify(after.columns)===JSON.stringify(before.columns),'table/column ACLs and RLS restore exactly');
 check(JSON.stringify(after.policies)===JSON.stringify(before.policies)&&after.functionHash===before.functionHash,'RLS policies and function bodies/ACLs restore exactly');
 const newBucket=await sdk.storage.createBucket(bucket,{public:false});if(newBucket.error)throw Error('Unique local restore bucket creation failed');bucketCreated=true;
 for(const object of manifest.objects){
  const name=object.metadata.bucket_id+'/'+object.metadata.name,bytes=fs.readFileSync(path.join(dir,object.file));
  const restored=await sdk.storage.from(bucket).upload(name,bytes,{contentType:object.metadata.metadata?.mimetype||'application/octet-stream',upsert:false});if(restored.error)throw Error('Local Storage restore upload failed');restoredPaths.push(name);
  const read=await sdk.storage.from(bucket).download(name);if(read.error)throw Error('Local Storage restore read failed');assert.equal(sha(Buffer.from(await read.data.arrayBuffer())),object.sha256);
 }
 check(restoredPaths.length===manifest.objects.length,'every exported object restores and reads back with the same SHA256 in a new private bucket');
 const removed=await sdk.storage.from(bucket).remove(restoredPaths);if(removed.error)throw Error('Local restore object cleanup failed');restoredPaths.length=0;const removedBucket=await sdk.storage.deleteBucket(bucket);if(removedBucket.error)throw Error('Local restore bucket cleanup failed');bucketCreated=false;
 check(!(await source.query('select 1 from storage.buckets where id=$1',[bucket])).rowCount,'temporary restore bucket and copied objects removed');
 const objectsAfter=(await source.query("select coalesce(jsonb_agg(to_jsonb(o) order by o.bucket_id,o.name),'[]') objects from storage.objects o")).rows[0].objects;
 // Downloads can update last_accessed_at; all identity/owner/metadata fields must remain unchanged.
 const stable=items=>items.map(({last_accessed_at,...o})=>o);
 check(JSON.stringify(stable(objectsAfter))===JSON.stringify(stable(storage.objects)),'source Storage object IDs, ownership and metadata preserved');
 await target.end();target=null;await source.query('drop database '+quote(name));created=false;check(!(await source.query('select 1 from pg_database where datname=$1',[name])).rowCount,'temporary restored database removed');
 const result={checks,applicationSchemas:schemas,applicationTables:Object.keys(before.rows).length,storageObjects:manifest.objects.length,storageBytes:manifest.objects.reduce((s,o)=>s+o.bytes,0),databaseSha256:sha(fs.readFileSync(archive)),storageManifestSha256:sha(fs.readFileSync(path.join(dir,'storage-manifest.json'))),productionBackupCreated:false,scope:'synthetic app schemas + all local Storage bytes and metadata export; file restore into a separate bucket; not a complete hosted platform/Auth/Vault restore'};
 fs.writeFileSync(path.join(root,'complete-backup-result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 if(bucketCreated){if(restoredPaths.length)await sdk.storage.from(bucket).remove(restoredPaths).catch(()=>{});await sdk.storage.deleteBucket(bucket).catch(()=>{});}
 if(target)await target.end().catch(()=>{});if(created)await source.query('drop database '+quote(name)+' with(force)').catch(()=>{});await source.end().catch(()=>{});
});
