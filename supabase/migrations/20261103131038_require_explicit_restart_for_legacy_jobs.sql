-- Preserve old records without silently replaying historical paid OCR/LINE work at cutover.
begin;
-- Seal all pre-cutover rows after the old unsigned ingress is closed and drained.
create table public.analysis_legacy_cutover (
  singleton boolean primary key default true check(singleton),
  sealed_at timestamptz, legacy_job_count integer
);
insert into public.analysis_legacy_cutover(singleton) values(true);
alter table public.analysis_legacy_cutover enable row level security;
revoke all on public.analysis_legacy_cutover from public,anon,authenticated,service_role;
grant select on public.analysis_legacy_cutover to service_role;
create function public.seal_legacy_analysis_jobs()
returns integer language plpgsql security invoker set search_path='' as $$
declare sealed timestamptz; n integer; current_mode text;
begin
  -- Same order as wake claims/mode changes; never hold jobs while waiting for worker state.
  perform public.lock_analysis_wake_state();
  select mode into current_mode from public.analysis_execution_policy where singleton for update;
  select sealed_at,legacy_job_count into sealed,n from public.analysis_legacy_cutover where singleton for update;
  if sealed is not null then return n; end if;
  if current_mode is distinct from 'disabled' then raise exception 'disable_and_drain_before_legacy_cutover'; end if;
  lock table public.analysis_jobs in access exclusive mode;
  update public.analysis_jobs set execution_mode='legacy' where execution_mode<>'legacy';
  select count(*) into n from public.analysis_jobs;
  update public.analysis_legacy_cutover set sealed_at=clock_timestamp(),legacy_job_count=n where singleton;
  return n;
end $$;
revoke all on function public.seal_legacy_analysis_jobs() from public,anon,authenticated,service_role;
grant execute on function public.seal_legacy_analysis_jobs() to postgres;

create or replace function public.analysis_processing_secure()
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.analysis_legacy_cutover where singleton and sealed_at is not null) and not exists(
    select 1 from unnest(array['users','invite_codes','unlimited_users','usage_limits','analysis_jobs','analysis_job_images','memo_jobs','memo_corrections','ocr_order_cache','manufacturers','catalogs','wallpapers']) n(name)
    join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass('public.' || n.name)
    where not c.relrowsecurity
      or pg_catalog.has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or pg_catalog.has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  ) and exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('storage.objects') and relrowsecurity)
    and exists(select 1 from storage.buckets where id='memo_uploads' and public=false);
$$;
create or replace function public.resumable_analysis_jobs()
returns table(id uuid) language sql security invoker set search_path='' as $$
  select j.id from public.analysis_jobs j where j.execution_mode <> 'legacy' and (
    (j.status in ('queued','running') and not exists(select 1 from public.analysis_job_images i where i.job_id=j.id and ((i.status='running' and coalesce(i.lease_expires_at,i.updated_at + interval '6 minutes')>now()) or (i.status in ('queued','running') and i.recovery_not_before>now()))))
    or (j.status='done' and j.notification_status in ('pending','failed') and j.notification_protocol='line_retry_v1')
  ) order by case when j.status='done' then 1 else 0 end,j.updated_at limit 3;
$$;
revoke all on function public.resumable_analysis_jobs() from public,anon,authenticated;
grant execute on function public.resumable_analysis_jobs() to service_role;
commit;
