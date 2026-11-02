-- Additional migration: safe after BOTH fresh and previously-applied Phase 1 versions.
-- Production execution requires approval. Apply before enabling any scheduled processor.
begin;
alter table public.analysis_jobs alter column notification_status set default 'legacy_unknown';
alter table public.analysis_jobs add column if not exists notification_protocol text not null default 'legacy_unknown';
-- A tracked attempt uses the stable LINE retry key; leased processing also proves the new protocol.
update public.analysis_jobs j set notification_protocol='line_retry_v1'
where j.notification_attempted_at is not null or j.notified_at is not null
   or exists(select 1 from public.analysis_job_images i where i.job_id=j.id and i.attempt_count>0);
-- Preserve exactly the metadata changed by quarantine for review/rollback reconciliation.
create table public.analysis_notification_migration_audit (
  job_id uuid primary key references public.analysis_jobs(id), previous_status text not null,
  previous_protocol text not null, captured_at timestamptz not null default now()
);
alter table public.analysis_notification_migration_audit enable row level security;
revoke all on public.analysis_notification_migration_audit from public,anon,authenticated;
grant all on public.analysis_notification_migration_audit to service_role;
insert into public.analysis_notification_migration_audit(job_id,previous_status,previous_protocol)
select id,notification_status,notification_protocol from public.analysis_jobs
where status='done' and notification_status in ('pending','failed') and notification_protocol='legacy_unknown';
-- Delivery is unknowable for older completed rows. Quarantine instead of resending or deleting.
update public.analysis_jobs set notification_status='legacy_unknown'
where status='done' and notification_status in ('pending','failed') and notification_protocol='legacy_unknown';

create table public.analysis_worker_state (
  worker_name text primary key check(worker_name='scheduled-v1'),
  previous_started_at timestamptz, last_started_at timestamptz not null,
  last_success_at timestamptz, last_error text
);
alter table public.analysis_worker_state enable row level security;
revoke all on public.analysis_worker_state from public,anon,authenticated;
grant all on public.analysis_worker_state to service_role;

create function public.analysis_worker_tick_start()
returns void language sql security invoker set search_path='' as $$
  insert into public.analysis_worker_state(worker_name,last_started_at) values('scheduled-v1',now())
  on conflict(worker_name) do update set
    previous_started_at=case when public.analysis_worker_state.last_started_at < now()-interval '30 seconds' then public.analysis_worker_state.last_started_at else public.analysis_worker_state.previous_started_at end,
    last_started_at=case when public.analysis_worker_state.last_started_at < now()-interval '30 seconds' then now() else public.analysis_worker_state.last_started_at end;
$$;
create function public.analysis_worker_tick_finish(p_success boolean)
returns void language sql security invoker set search_path='' as $$
  update public.analysis_worker_state set
    last_success_at=case when p_success then now() else last_success_at end,
    last_error=case when p_success then null else 'scheduled batch failed' end
  where worker_name='scheduled-v1';
$$;
-- Minimum deployment preconditions; real anonymous Storage/API tests are still required.
-- Scheduled work must not run while legacy anonymous table access remains open.
create function public.analysis_processing_secure()
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists(
    select 1 from unnest(array['users','invite_codes','unlimited_users','usage_limits','analysis_jobs','analysis_job_images','memo_jobs','memo_corrections','ocr_order_cache','manufacturers','catalogs','wallpapers']) n(name)
    join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass('public.' || n.name)
    where not c.relrowsecurity
      or pg_catalog.has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or pg_catalog.has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  ) and exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('storage.objects') and relrowsecurity)
    and exists(select 1 from storage.buckets where id='memo_uploads' and public=false);
$$;
create function public.analysis_background_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select public.analysis_processing_secure() and exists(select 1 from public.analysis_worker_state where worker_name='scheduled-v1'
    and last_started_at > now()-interval '2 minutes'
    and previous_started_at > now()-interval '3 minutes'
    and last_started_at-previous_started_at >= interval '30 seconds'
    and last_success_at > now()-interval '6 minutes' and last_error is null);
$$;

create or replace function public.resumable_analysis_jobs()
returns table(id uuid) language sql security invoker set search_path='' as $$
  select j.id from public.analysis_jobs j where
    (j.status in ('queued','running') and not exists(select 1 from public.analysis_job_images i where i.job_id=j.id and ((i.status='running' and coalesce(i.lease_expires_at,i.updated_at + interval '6 minutes')>now()) or (i.status in ('queued','running') and i.recovery_not_before>now()))))
    or (j.status='done' and j.notification_status in ('pending','failed') and j.notification_protocol='line_retry_v1')
  order by case when j.status='done' then 1 else 0 end,j.updated_at limit 3;
$$;
create or replace function public.create_analysis_job(p_line_user_id text, p_paths text[], p_site_name text, p_owner boolean default false)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_job uuid; v_count integer; v_month text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM');
begin
  if coalesce(array_length(p_paths, 1),0) < 1 or array_length(p_paths,1) > 5 then raise exception 'invalid_images'; end if;
  if not exists(select 1 from public.users where line_user_id = p_line_user_id) then raise exception 'invalid_user'; end if;
  if exists(select 1 from unnest(p_paths) path where path is null or path not like p_line_user_id || '/%') then raise exception 'invalid_images'; end if;
  if not public.analysis_background_ready() then raise exception 'worker_unavailable'; end if;
  if not p_owner and not exists(select 1 from public.unlimited_users where line_user_id = p_line_user_id) then
    insert into public.usage_limits(line_user_id, year_month, image_count, updated_at)
    values(p_line_user_id, v_month, array_length(p_paths,1), now())
    on conflict(line_user_id, year_month) do update
      set image_count = coalesce(public.usage_limits.image_count,0) + excluded.image_count, updated_at = now()
      where coalesce(public.usage_limits.image_count,0) + excluded.image_count <= 20
    returning image_count into v_count;
    if v_count is null then raise exception 'monthly_limit'; end if;
  end if;
  insert into public.analysis_jobs(line_user_id,site_name,total_images,context,notification_status,notification_protocol) values(p_line_user_id,p_site_name,array_length(p_paths,1),jsonb_build_object('site_name',p_site_name),'pending','line_retry_v1') returning id into v_job;
  insert into public.analysis_job_images(job_id,idx,url,recovery_not_before) select v_job, ordinality - 1, path, now() from unnest(p_paths) with ordinality paths(path,ordinality);
  return v_job;
end $$;
revoke all on function public.analysis_processing_secure() from public,anon,authenticated;
grant execute on function public.analysis_processing_secure() to service_role;
revoke all on function public.analysis_worker_tick_start(),public.analysis_worker_tick_finish(boolean),public.analysis_background_ready() from public,anon,authenticated;
grant execute on function public.analysis_worker_tick_start(),public.analysis_worker_tick_finish(boolean),public.analysis_background_ready() to service_role;
commit;
