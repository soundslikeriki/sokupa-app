-- Additive upgrade: legacy start/success timestamps cannot prove two successful invocations.
-- Keep all user/job/notification data. Deploy with intake disabled and old workers drained.
begin;
alter table public.analysis_worker_state
  add column health_epoch uuid not null default gen_random_uuid(),
  add column health_reset_at timestamptz not null default clock_timestamp(),
  add column last_tick_started_at timestamptz;

create table public.analysis_worker_ticks (
  id uuid primary key default gen_random_uuid(),
  health_epoch uuid not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  succeeded boolean,
  check ((finished_at is null) = (succeeded is null))
);
create index analysis_worker_ticks_success on public.analysis_worker_ticks(health_epoch,started_at) where succeeded=true;
create index analysis_worker_ticks_started on public.analysis_worker_ticks(started_at);
alter table public.analysis_worker_ticks enable row level security;
revoke all on public.analysis_worker_ticks from public,anon,authenticated;
grant all on public.analysis_worker_ticks to service_role;

create function public.analysis_worker_tick_begin()
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_state public.analysis_worker_state%rowtype; v_now timestamptz; v_id uuid;
begin
  insert into public.analysis_worker_state(worker_name,last_started_at)
    values('scheduled-v1',clock_timestamp()) on conflict(worker_name) do nothing;
  select * into v_state from public.analysis_worker_state where worker_name='scheduled-v1' for update;
  v_now := clock_timestamp();
  -- After a scheduler gap/restart, old successful ticks cannot reopen intake.
  if v_state.last_tick_started_at is null or v_state.last_tick_started_at < v_now-interval '2 minutes' or v_state.last_tick_started_at > v_now then
    v_state.health_epoch := gen_random_uuid();
    update public.analysis_worker_state set health_epoch=v_state.health_epoch,health_reset_at=v_now,
      last_success_at=null,last_error='waiting for two successful scheduled ticks' where worker_name='scheduled-v1';
  end if;
  update public.analysis_worker_state set previous_started_at=last_started_at,last_started_at=v_now,last_tick_started_at=v_now where worker_name='scheduled-v1';
  insert into public.analysis_worker_ticks(health_epoch,started_at) values(v_state.health_epoch,v_now) returning id into v_id;
  -- Retain a bounded operational history, independent of users and job data.
  delete from public.analysis_worker_ticks where started_at < v_now-interval '1 day';
  return v_id;
end $$;

create function public.analysis_worker_tick_complete(p_tick_id uuid,p_success boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_state public.analysis_worker_state%rowtype; v_tick public.analysis_worker_ticks%rowtype; v_now timestamptz; v_success boolean;
begin
  if p_success is null then return false; end if;
  -- All begin/complete operations take this lock first, including concurrent callbacks.
  select * into v_state from public.analysis_worker_state where worker_name='scheduled-v1' for update;
  if not found then return false; end if;
  select * into v_tick from public.analysis_worker_ticks where id=p_tick_id for update;
  if not found then return false; end if;
  -- One invocation has one immutable outcome. Replays cannot count twice or change failure to success.
  if v_tick.finished_at is not null then return v_tick.succeeded=p_success and v_tick.health_epoch=v_state.health_epoch; end if;
  v_now := clock_timestamp();
  v_success := p_success and v_tick.started_at<=v_now and v_tick.started_at>v_now-interval '6 minutes';
  update public.analysis_worker_ticks set finished_at=v_now,succeeded=v_success where id=p_tick_id;
  -- Late completions from before a failure/restart never heal the current epoch.
  if v_tick.health_epoch<>v_state.health_epoch then return false; end if;
  if v_success then
    update public.analysis_worker_state set last_success_at=v_now,last_error=null where worker_name='scheduled-v1';
  else
    update public.analysis_worker_state set health_epoch=gen_random_uuid(),health_reset_at=v_now,
      last_success_at=null,last_error='scheduled batch failed' where worker_name='scheduled-v1';
  end if;
  return v_success=p_success;
end $$;

create or replace function public.analysis_background_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select public.analysis_processing_secure() and exists(
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

-- An old deployment cannot manufacture v2 health via the former unpaired callbacks.
revoke all on function public.analysis_worker_tick_start(),public.analysis_worker_tick_finish(boolean) from public,anon,authenticated,service_role;
revoke all on function public.analysis_worker_tick_begin(),public.analysis_worker_tick_complete(uuid,boolean) from public,anon,authenticated;
grant execute on function public.analysis_worker_tick_begin(),public.analysis_worker_tick_complete(uuid,boolean) to service_role;
commit;
