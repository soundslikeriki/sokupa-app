-- Fail-closed transport gate. Does not enable a scheduler or create credentials.
begin;
create table public.analysis_scheduler_transport_state(
  name text primary key check(name='supabase-v1'),required boolean not null default false,enabled boolean not null default false,
  epoch uuid not null default gen_random_uuid(),reset_at timestamptz not null default clock_timestamp(),
  last_enqueue_at timestamptz,failed_at timestamptz,failure_code text
);
create table public.analysis_scheduler_transport_attempts(
  id uuid primary key,epoch uuid not null,enqueued_at timestamptz not null,
  expires_at timestamptz not null,response_deadline timestamptz not null,
  outcome text not null default 'pending',completed_at timestamptz,worker_tick_id uuid
);
create index analysis_scheduler_transport_attempts_health on public.analysis_scheduler_transport_attempts(epoch,enqueued_at) where outcome='succeeded';
alter table public.analysis_scheduler_dispatches add column worker_tick_id uuid;
alter table public.analysis_scheduler_transport_state enable row level security;
alter table public.analysis_scheduler_transport_attempts enable row level security;
revoke all on public.analysis_scheduler_transport_state,public.analysis_scheduler_transport_attempts from public,anon,authenticated,service_role;
grant select on public.analysis_scheduler_transport_state,public.analysis_scheduler_transport_attempts to service_role;

create function public.configure_analysis_transport(p_enabled boolean)
returns void language sql security invoker set search_path='' as $$
  insert into public.analysis_scheduler_transport_state(name,required,enabled,failure_code)
    values('supabase-v1',p_enabled,p_enabled,'waiting_for_two_verified_responses')
  on conflict(name) do update set required=public.analysis_scheduler_transport_state.required or p_enabled,enabled=p_enabled,
    epoch=gen_random_uuid(),reset_at=clock_timestamp(),last_enqueue_at=null,failed_at=null,failure_code='waiting_for_two_verified_responses';
$$;
create function public.begin_analysis_transport_dispatch(p_id uuid,p_issued_at bigint,p_expires_at bigint)
returns uuid language plpgsql security invoker set search_path='' as $$
declare s public.analysis_scheduler_transport_state%rowtype;t timestamptz:=clock_timestamp();
begin
  select * into s from public.analysis_scheduler_transport_state where name='supabase-v1' for update;
  if not found or not s.required or not s.enabled then raise exception 'transport_not_enabled'; end if;
  if p_id is null or p_issued_at is null or p_expires_at is null or p_issued_at>extract(epoch from t)+15 or p_issued_at<extract(epoch from t)-120 or p_expires_at<=extract(epoch from t) or p_expires_at-p_issued_at not between 1 and 120 then raise exception 'invalid_dispatch'; end if;
  if s.last_enqueue_at is null or s.last_enqueue_at<t-interval '2 minutes' or s.last_enqueue_at>t then
    s.epoch:=gen_random_uuid();
    update public.analysis_scheduler_transport_state set epoch=s.epoch,reset_at=t,failed_at=null,failure_code='waiting_for_two_verified_responses' where name=s.name;
  end if;
  insert into public.analysis_scheduler_transport_attempts(id,epoch,enqueued_at,expires_at,response_deadline)
    values(p_id,s.epoch,t,to_timestamp(p_expires_at),t+interval '450 seconds');
  update public.analysis_scheduler_transport_state set last_enqueue_at=t where name=s.name;
  delete from public.analysis_scheduler_transport_attempts where outcome<>'pending' and enqueued_at<t-interval '1 day';
  return s.epoch;
end $$;

create function public.fail_analysis_transport(p_code text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_code is null or p_code not in ('enqueue_failed','queue_saturated','observation_failed') then raise exception 'invalid_transport_failure'; end if;
  update public.analysis_scheduler_transport_state set epoch=gen_random_uuid(),reset_at=clock_timestamp(),failed_at=clock_timestamp(),failure_code=p_code where name='supabase-v1' and required;
end $$;

-- Called by the signed HTTP worker, not the transport observer. Links the nonce to a real tick.
create function public.begin_signed_analysis_worker_tick(p_dispatch_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare d public.analysis_scheduler_dispatches%rowtype;v_tick uuid;
begin
  select * into d from public.analysis_scheduler_dispatches where id=p_dispatch_id for update;
  if not found or d.expires_at<=clock_timestamp() then return null; end if;
  if not exists(select 1 from public.analysis_scheduler_transport_attempts a join public.analysis_scheduler_transport_state s on s.epoch=a.epoch
    where a.id=d.id and a.outcome='pending' and s.name='supabase-v1' and s.required and s.enabled) then return null; end if;
  if d.worker_tick_id is not null then return d.worker_tick_id; end if;
  v_tick:=public.analysis_worker_tick_begin();
  update public.analysis_scheduler_dispatches set worker_tick_id=v_tick where id=d.id;
  return v_tick;
end $$;

-- p_completed_at is the observer's confirmation time, not net._http_response.created.
-- pg_net may keep its transaction-start timestamp throughout a long HTTP batch.
create function public.record_analysis_transport_result(p_id uuid,p_outcome text,p_tick_id uuid,p_completed_at timestamptz)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.analysis_scheduler_transport_state%rowtype;a public.analysis_scheduler_transport_attempts%rowtype;v_outcome text:=p_outcome;t timestamptz:=clock_timestamp();
begin
  if p_outcome is null or p_outcome not in ('succeeded','failed','expired','invalid_response') then raise exception 'invalid_transport_outcome'; end if;
  select * into s from public.analysis_scheduler_transport_state where name='supabase-v1' for update;
  if not found then return false; end if;
  select * into a from public.analysis_scheduler_transport_attempts where id=p_id for update;
  if not found then return false; end if;
  if a.outcome<>'pending' then return a.outcome=p_outcome and a.epoch=s.epoch; end if;
  if p_completed_at is null or p_completed_at<a.enqueued_at or p_completed_at>t or p_completed_at>a.response_deadline then v_outcome:='expired'; end if;
  if v_outcome='succeeded' and not exists(
    select 1 from public.analysis_scheduler_dispatches d join public.analysis_worker_ticks w on w.id=d.worker_tick_id
    where d.id=p_id and w.id=p_tick_id and w.succeeded=true and w.started_at>=a.enqueued_at and w.finished_at<=p_completed_at
  ) then v_outcome:='invalid_response'; end if;
  update public.analysis_scheduler_transport_attempts set outcome=v_outcome,completed_at=coalesce(p_completed_at,t),worker_tick_id=p_tick_id where id=p_id;
  -- Old/replayed responses cannot reset or heal the current transport generation.
  if a.epoch<>s.epoch then return false; end if;
  if v_outcome<>'succeeded' then
    update public.analysis_scheduler_transport_state set epoch=gen_random_uuid(),reset_at=t,failed_at=t,failure_code=v_outcome where name=s.name;
  end if;
  return v_outcome='succeeded';
end $$;

create function public.analysis_transport_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists(select 1 from public.analysis_scheduler_transport_state where required) or exists(
    select 1 from public.analysis_scheduler_transport_state s
    join public.analysis_scheduler_transport_attempts a on a.epoch=s.epoch and a.outcome='succeeded'
    join public.analysis_scheduler_transport_attempts b on b.epoch=s.epoch and b.outcome='succeeded'
    where s.name='supabase-v1' and s.required and s.enabled
      and s.last_enqueue_at>now()-interval '2 minutes' and s.last_enqueue_at<=now()
      and a.enqueued_at>=s.reset_at and b.enqueued_at>=s.reset_at
      and a.enqueued_at>now()-interval '2 minutes' and a.enqueued_at<=now()
      and b.enqueued_at>now()-interval '3 minutes' and a.enqueued_at-b.enqueued_at>=interval '30 seconds'
      and a.completed_at>now()-interval '6 minutes' and a.completed_at<=now()
      and b.completed_at>now()-interval '6 minutes' and b.completed_at<=now()
  );
$$;
create or replace function public.analysis_background_ready()
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
-- An already-enabled older candidate must remain closed until its template is upgraded.
do $$ begin
  if to_regclass('sokupa_ops.scheduler_config') is not null then
    execute 'insert into public.analysis_scheduler_transport_state(name,required,enabled,failure_code) select ''supabase-v1'',true,false,''template_upgrade_required'' from sokupa_ops.scheduler_config where enabled on conflict(name) do update set required=true,enabled=false,epoch=gen_random_uuid(),reset_at=clock_timestamp(),failure_code=''template_upgrade_required''';
  end if;
end $$;
revoke all on function public.configure_analysis_transport(boolean),public.begin_analysis_transport_dispatch(uuid,bigint,bigint),public.record_analysis_transport_result(uuid,text,uuid,timestamptz),public.fail_analysis_transport(text) from public,anon,authenticated,service_role;
revoke all on function public.analysis_transport_ready(),public.begin_signed_analysis_worker_tick(uuid) from public,anon,authenticated;
grant execute on function public.analysis_transport_ready(),public.begin_signed_analysis_worker_tick(uuid) to service_role;
commit;
