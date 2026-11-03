-- Preserve IDs/results; discover accepted work even when device storage fails.
begin;
alter table public.analysis_jobs add column client_result_seen_at timestamptz;
alter table public.analysis_jobs add column execution_mode text not null default 'legacy'
  check(execution_mode in ('legacy','disabled','interactive','scheduled','scheduled-wake'));
-- Legacy terminal jobs have no view receipt; do not overwrite existing drafts by rediscovering every historical result.
-- Explicit legacy lastJobId links still work. Unfinished old jobs remain discoverable.
update public.analysis_jobs set client_result_seen_at=updated_at where status in ('done','failed');
create function public.stamp_analysis_execution_mode()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.execution_mode:=coalesce((select mode from public.analysis_execution_policy where singleton),'disabled');return new;
end $$;
create trigger analysis_job_execution_mode before insert on public.analysis_jobs
  for each row execute function public.stamp_analysis_execution_mode();
create index analysis_jobs_owner_recovery on public.analysis_jobs(line_user_id,updated_at desc)
  where client_result_seen_at is null or status in ('queued','running') or notification_status in ('pending','failed');
revoke all on function public.stamp_analysis_execution_mode() from public,anon,authenticated;
grant execute on function public.stamp_analysis_execution_mode() to service_role;
commit;
