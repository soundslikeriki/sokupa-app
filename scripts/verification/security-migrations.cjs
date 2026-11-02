// Standalone, synthetic-only PostgreSQL verification. No network or production credentials.
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const db = new PGlite();
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const sql = (text) => db.exec(text);
  const scalar = async (text) => (await db.query(text)).rows[0];
  await sql(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage;
    grant usage on schema public,storage to anon,authenticated,service_role;
    create table users(id uuid default gen_random_uuid(), line_user_id text unique not null, display_name text, picture_url text, invite_code text, last_login_at timestamptz);
    create table invite_codes(id uuid default gen_random_uuid(), code text unique not null, is_used boolean default false, used_at timestamptz);
    create table unlimited_users(id uuid default gen_random_uuid(), line_user_id text unique);
    create table usage_limits(line_user_id text not null, year_month text not null, image_count integer default 0, updated_at timestamptz, unique(line_user_id,year_month));
    create table analysis_jobs(id uuid primary key default gen_random_uuid(), line_user_id text, site_name text, status text default 'queued', total_images integer default 0, done_images integer default 0, context jsonb default '{}', result jsonb, error text, updated_at timestamptz default now());
    create table analysis_job_images(id uuid default gen_random_uuid(), job_id uuid references analysis_jobs(id), idx integer, url text, status text default 'queued');
    create table ocr_order_cache(id integer); create table memo_jobs(id integer);
    create table manufacturers(id integer); create table catalogs(id integer); create table wallpapers(id integer);
    create table storage.buckets(id text primary key, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    insert into storage.buckets values('memo_uploads',true,null,null),('other_bucket',true,null,null);
    create table storage.objects(bucket_id text,name text);
    alter table storage.objects enable row level security;
    create policy "Public insert memo_uploads" on storage.objects for insert to public with check (bucket_id='memo_uploads');
    create policy "Public read memo_uploads" on storage.objects for select to public using(bucket_id='memo_uploads');
    create policy "Other bucket policy" on storage.objects for select to public using(bucket_id='other_bucket');
    grant all on all tables in schema public,storage to anon,authenticated,service_role;
    insert into users(line_user_id,invite_code) values('legacy-null',null),('limited',null),('unlimited',null),('owner',null);
    insert into unlimited_users(line_user_id) values('unlimited');
    insert into invite_codes(code) values('ABCDEFGH'),('ROLLBACK');
  `);
  await sql(readFileSync(resolve('supabase/migrations/20261102183016_session_api_expansion.sql'), 'utf8'));
  await sql('grant all on public.memo_corrections to service_role');
  // Existing browser paths still work during additive phase.
  await sql('set role anon; select * from public.users; reset role'); checks++;
  const asRole = async (role, query) => { await sql(`set role ${role}`); try { return await scalar(query); } finally { await sql('reset role'); } };
  await assert.rejects(asRole('anon', `select public.register_invited_line_user('bad',null,null,'ABCDEFGH')`), /permission denied/); checks++;
  await asRole('service_role', `select public.register_invited_line_user('new-user','Test',null,'ABCDEFGH')`);
  check((await scalar("select is_used from invite_codes where code='ABCDEFGH'")).is_used, 'invitation consumed');
  check((await scalar("select invite_code from users where line_user_id='new-user'")).invite_code === 'ABCDEFGH', 'same LINE ID registered');
  await assert.rejects(asRole('service_role', `select public.register_invited_line_user('second-user',null,null,'ABCDEFGH')`), /invalid_invite/); checks++;
  await asRole('service_role', `select public.register_invited_line_user('legacy-null',null,null,'MISSING')`);
  check((await scalar("select invite_code from users where line_user_id='legacy-null'")).invite_code === null, 'existing users with no invite are preserved');
  const paths = "ARRAY['limited/00000000-0000-4000-8000-000000000000.jpg']";
  await sql(`insert into usage_limits values('limited',to_char(now() at time zone 'Asia/Tokyo','YYYY-MM'),19,now())`);
  await asRole('service_role', `select public.create_analysis_job('limited',${paths},'Synthetic',false)`);
  await assert.rejects(asRole('service_role', `select public.create_analysis_job('limited',${paths},'Synthetic',false)`), /monthly_limit/); checks++;
  check((await scalar("select image_count from usage_limits where line_user_id='limited'")).image_count === 20, 'quota never exceeded');
  check((await scalar("select count(*)::integer as n from analysis_jobs where line_user_id='limited'")).n === 1, 'no orphan job on limit error');
  for (const [id,owner] of [['unlimited',false],['owner',true]]) {
    await asRole('service_role', `select public.create_analysis_job('${id}',ARRAY['${id}/00000000-0000-4000-8000-000000000000.jpg'],'Synthetic',${owner})`);
    check((await scalar(`select count(*)::integer as n from usage_limits where line_user_id='${id}'`)).n === 0, `${id} bypasses quota`);
  }
  await assert.rejects(asRole('service_role', `select public.create_analysis_job('legacy-null',ARRAY['other/path.jpg'],'Synthetic',false)`), /invalid_images/); checks++;
  await sql(`create function test_reject_user() returns trigger language plpgsql as $$ begin if new.line_user_id='rollback-user' then raise exception 'synthetic_insert_failure'; end if; return new; end $$; create trigger test_reject_user before insert on users for each row execute function test_reject_user();`);
  await assert.rejects(asRole('service_role', `select public.register_invited_line_user('rollback-user',null,null,'ROLLBACK')`), /synthetic_insert_failure/); checks++;
  check((await scalar("select is_used from invite_codes where code='ROLLBACK'")).is_used === false, 'registration rolls back invite consumption');
  const before = await scalar('select count(*)::integer as n from users');
  await sql(readFileSync(resolve('supabase/rollout/20261102183142_restrict_private_data_access.sql'), 'utf8'));
  for (const role of ['anon','authenticated']) {
    for (const table of ['users','invite_codes','unlimited_users','usage_limits','analysis_jobs','analysis_job_images','memo_corrections','ocr_order_cache','memo_jobs','manufacturers','catalogs','wallpapers']) {
      await assert.rejects(asRole(role, `select * from public.${table}`), /permission denied/); checks++;
    }
    await assert.rejects(asRole(role, `select public.create_analysis_job('owner',ARRAY['owner/path'],'bad',true)`), /permission denied/); checks++;
    await assert.rejects(asRole(role, `insert into storage.objects values('memo_uploads','denied.jpg') returning name`), /row-level security/); checks++;
  }
  check((await asRole('service_role','select count(*)::integer as n from users')).n === before.n, 'user records unchanged after lockdown');
  check((await scalar("select public from storage.buckets where id='memo_uploads'")).public === false, 'memo bucket private');
  check((await scalar("select public from storage.buckets where id='other_bucket'")).public === true, 'other buckets unchanged');
  check((await scalar("select count(*)::integer as n from pg_policies where schemaname='storage' and policyname='Other bucket policy'")).n === 1, 'unrelated policy unchanged');
  await db.close();
  console.log(`PASS: ${checks} isolated PostgreSQL checks; no production access or real data.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
