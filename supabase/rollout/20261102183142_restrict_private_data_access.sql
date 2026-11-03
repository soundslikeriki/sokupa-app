-- Phase 2: APPROVAL REQUIRED. Only after the authenticated client/worker is deployed and verified.
-- Keeps all rows and LINE IDs. Custom signed sessions use API ownership checks, not Supabase JWTs.
begin;
-- Acquire worker/wake/policy before table locks when upgrading a wake-capable installation.
do $$ begin
  if to_regprocedure('public.lock_analysis_wake_state()') is not null then
    perform public.lock_analysis_wake_state();
    perform 1 from public.analysis_execution_policy where singleton for update;
  end if;
end $$;
do $$
declare t text; policy record;
begin
  foreach t in array array['users','invite_codes','unlimited_users','usage_limits','analysis_jobs','analysis_job_images','memo_corrections','ocr_order_cache','memo_jobs','manufacturers','catalogs','wallpapers'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security',t);
    for policy in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I',policy.policyname,t);
    end loop;
    execute format('revoke all on table public.%I from public, anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;
-- Remove the exact memo-only policies observed in production and in repository migrations.
-- Do not alter policies for other buckets. Review pg_policies again before applying.
drop policy if exists "Public read memo_uploads" on storage.objects;
drop policy if exists "Allow public upload to memo_uploads" on storage.objects;
drop policy if exists "Allow public select from memo_uploads" on storage.objects;
drop policy if exists "Public insert memo_uploads" on storage.objects;
drop policy if exists "Public update memo_uploads" on storage.objects;
update storage.buckets set public = false, file_size_limit = 4194304, allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id='memo_uploads';
-- Idempotent seal runs only after all legacy anonymous ingress above is closed.
do $$ begin
  if to_regprocedure('public.seal_legacy_analysis_jobs()') is not null then perform public.seal_legacy_analysis_jobs(); end if;
end $$;
commit;
