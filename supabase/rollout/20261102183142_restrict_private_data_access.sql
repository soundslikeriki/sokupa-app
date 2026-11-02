-- Phase 2: APPROVAL REQUIRED. Only after the authenticated client/worker is deployed and verified.
-- Keeps all rows and LINE IDs. Custom signed sessions use API ownership checks, not Supabase JWTs.
begin;
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
commit;
