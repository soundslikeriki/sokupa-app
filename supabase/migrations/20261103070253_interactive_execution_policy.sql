-- Explicit execution policy. Keeps scheduled verification intact; creates no scheduler/credentials.
begin;
create table public.analysis_execution_policy(
  singleton boolean primary key default true check(singleton),
  mode text not null default 'scheduled' check(mode in ('disabled','interactive','scheduled')),
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.analysis_execution_policy(singleton) values(true);
alter table public.analysis_execution_policy enable row level security;
revoke all on public.analysis_execution_policy from public,anon,authenticated,service_role;
grant select on public.analysis_execution_policy to service_role;

create function public.set_analysis_execution_mode(p_mode text)
returns void language plpgsql security invoker set search_path='' as $$
declare previous text;
begin
  if p_mode is null or p_mode not in ('disabled','interactive','scheduled') then raise exception 'invalid_execution_mode'; end if;
  select mode into previous from public.analysis_execution_policy where singleton for update;
  if not found then raise exception 'execution_policy_missing'; end if;
  if p_mode='interactive' and not public.analysis_processing_secure() then raise exception 'private_data_access_required'; end if;
  update public.analysis_execution_policy set mode=p_mode,updated_at=clock_timestamp() where singleton;
  if previous<>p_mode then
    update public.analysis_worker_state set health_epoch=gen_random_uuid(),health_reset_at=clock_timestamp(),
      last_tick_started_at=null,last_success_at=null,last_error='execution mode changed' where worker_name='scheduled-v1';
  end if;
end $$;

-- Same predicate as the verified scheduler: the interactive mode never manufactures a healthy tick.
create function public.analysis_scheduled_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select public.analysis_processing_secure() and public.analysis_provider_available() and public.analysis_transport_ready() and exists(
    select 1 from public.analysis_worker_state s
    join public.analysis_worker_ticks newer on newer.health_epoch=s.health_epoch and newer.succeeded=true
    join public.analysis_worker_ticks older on older.health_epoch=s.health_epoch and older.succeeded=true
    where s.worker_name='scheduled-v1'
      and s.last_tick_started_at>now()-interval '2 minutes' and s.last_tick_started_at<=now()
      and older.started_at>=s.health_reset_at and newer.started_at>=s.health_reset_at
      and newer.started_at>now()-interval '2 minutes' and newer.started_at<=now()
      and older.started_at>now()-interval '3 minutes'
      and newer.started_at-older.started_at>=interval '30 seconds'
      and newer.finished_at<=now() and older.finished_at<=now()
      and newer.finished_at>now()-interval '6 minutes' and older.finished_at>now()-interval '6 minutes'
  );
$$;
create or replace function public.analysis_background_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select case (select mode from public.analysis_execution_policy where singleton)
    when 'interactive' then public.analysis_processing_secure() and public.analysis_provider_available()
    when 'scheduled' then public.analysis_scheduled_ready()
    else false end;
$$;
create function public.analysis_admission_ready(p_mode text)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(p_mode in ('interactive','scheduled')
    and p_mode=(select mode from public.analysis_execution_policy where singleton)
    and public.analysis_background_ready(),false);
$$;
revoke all on function public.set_analysis_execution_mode(text) from public,anon,authenticated,service_role;
revoke all on function public.analysis_scheduled_ready(),public.analysis_admission_ready(text) from public,anon,authenticated;
grant execute on function public.analysis_scheduled_ready(),public.analysis_admission_ready(text) to service_role;
commit;
