// Synthetic application backup rehearsal. Only the previously approved disposable native stack.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const{Client}=require(process.env.PG_CLIENT_MODULE||'pg');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable stack root required');
const start=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.DB_URL);
if(start?.runtime!=='native')throw Error('Native metadata required');
const url=new URL(start.env.DB_URL);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/postgres')throw Error('Non-local source refused');
url.username='supabase_admin';url.password='';
const dbName='sokupa_restore_drill_'+Date.now();
const source=new Client({connectionString:url.toString(),ssl:false,connectionTimeoutMillis:5000});
let restored,checks=0,created=false;const check=(ok,message)=>{assert.ok(ok,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const quote=name=>'"'+name.replaceAll('"','""')+'"';
async function snapshot(client){
 const tables=(await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r=>r.tablename);
 const rows={};
 for(const table of tables){const data=(await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) data from public.${quote(table)} t`)).rows[0].data;rows[table]={count:data.length,sha256:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')};}
 const privacy=(await client.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname")).rows;
 return {rows,privacy};
}
(async()=>{
 await source.connect();const data=(await source.query("select current_setting('data_directory') data")).rows[0].data;
 check(fs.realpathSync(data).startsWith(fs.realpathSync(root)+path.sep),'source cluster belongs to this disposable root');
 check((await source.query('select id from sokupa_local_verification_only')).rows[0].id==='synthetic-only','synthetic-only fixture marker');
 check((await source.query("select count(*)::int n from users where line_user_id not in ('local-owner','local-limited')")).rows[0].n===0,'no production user IDs in source');
 check((await source.query("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).rows[0].n===0,'no application cron is active');
 const dirs=fs.readdirSync(path.join(root,'state/cache/stack/slim-services/postgres'),{recursive:true});
 const entry=dirs.find(n=>String(n).endsWith('/bin/pg_dump'));
 if(!entry)throw Error('Isolated official pg_dump absent');
 const bin=path.dirname(path.join(root,'state/cache/stack/slim-services/postgres',entry));
 execFileSync(path.join(bin,'pg_dump'),['--help'],{stdio:'pipe'});execFileSync(path.join(bin,'pg_restore'),['--help'],{stdio:'pipe'});
 const env={PATH:process.env.PATH,PGHOST:url.hostname,PGPORT:url.port,PGUSER:'supabase_admin',PGDATABASE:'postgres',SSL_CERT_FILE:path.join(root,'tls/ca-bundle.pem')};
 const before=await snapshot(source),archive=path.join(root,'synthetic-public-backup.dump');
 fs.closeSync(fs.openSync(archive,'w',0o600));
 execFileSync(path.join(bin,'pg_dump'),['--format=custom','--schema=public','--file',archive],{env,stdio:'pipe',timeout:30000});
 check(fs.statSync(archive).size>0,'actual pg_dump creates a synthetic public-schema archive');
 assert.match(dbName,/^sokupa_restore_drill_\d+$/);
 check(!(await source.query('select 1 from pg_database where datname=$1',[dbName])).rowCount,'restore target is a fresh test database');
 await source.query('create database '+quote(dbName));created=true;
 execFileSync(path.join(bin,'pg_restore'),['--clean','--if-exists','--exit-on-error','--dbname',dbName,archive],{env,stdio:'pipe',timeout:30000});
 const targetUrl=new URL(url);targetUrl.pathname='/'+dbName;restored=new Client({connectionString:targetUrl.toString(),ssl:false});await restored.connect();
 const after=await snapshot(restored);
 check(JSON.stringify(after.rows)===JSON.stringify(before.rows),'all synthetic public rows, IDs and job/notification states survive actual restore');
 check(JSON.stringify(after.privacy)===JSON.stringify(before.privacy),'table ACLs and RLS flags survive actual restore');
 check((await restored.query('select count(*)::int n from users')).rows[0].n===2,'both synthetic user IDs restored');
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
 await restored.end();restored=null;await source.query('drop database '+quote(dbName));created=false;
 check(!(await source.query('select 1 from pg_database where datname=$1',[dbName])).rowCount,'temporary restore database removed');
 const result={checks,tables:Object.keys(before.rows).length,sha256,bytes:fs.statSync(archive).size,scope:'synthetic public schema only',storageFilesBackedUp:false,productionBackupCreated:false};
 fs.writeFileSync(path.join(root,'backup-restore-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 if(restored)await restored.end().catch(()=>{});
 if(created)await source.query('drop database '+quote(dbName)+' with (force)').catch(()=>{});
 await source.end().catch(()=>{});
});
