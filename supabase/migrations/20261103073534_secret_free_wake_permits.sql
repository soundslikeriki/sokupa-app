-- Private DB permits authorize work. Public pg_net requests carry no credential or job data.
-- This migration creates no Cron job, network request or secret.
begin;
alter table public.analysis_execution_policy drop constraint analysis_execution_policy_mode_check;
alter table public.analysis_execution_policy add constraint analysis_execution_policy_mode_check
  check(mode in ('disabled','interactive','scheduled','scheduled-wake'));

create table public.analysis_wake_state(
  singleton boolean primary key default true check(singleton),enabled boolean not null default false,
  origin text,expect_processing boolean not null default false,
  epoch uuid not null default gen_random_uuid(),reset_at timestamptz not null default clock_timestamp(),
  last_enqueue_at timestamptz,failed_at timestamptz,failure_code text,
  check(origin is null or (origin ~ '^https://[a-z0-9][a-z0-9.-]*[a-z0-9](:[1-9][0-9]{0,4})?$'
    and coalesce(substring(origin from ':([0-9]+)$')::numeric,443) between 1 and 65535))
);
insert into public.analysis_wake_state(singleton) values(true);
create table public.analysis_wake_permits(
  id uuid primary key default gen_random_uuid(),slot timestamptz not null unique,epoch uuid not null,
  issued_at timestamptz not null,expires_at timestamptz not null,processing_enabled boolean not null,
  status text not null default 'pending' check(status in ('pending','claimed','succeeded','failed','expired')),
  claim_token uuid,claimed_at timestamptz,worker_tick_id uuid references public.analysis_worker_ticks(id) on delete set null,
  completed_at timestamptz,transport_status text not null default 'pending' check(transport_status in ('pending','accepted','failed','expired')),
  check(expires_at>issued_at and expires_at<=issued_at+interval '120 seconds')
);
create index analysis_wake_pending on public.analysis_wake_permits(issued_at) where status in ('pending','claimed');
alter table public.analysis_wake_state enable row level security;
alter table public.analysis_wake_permits enable row level security;
revoke all on public.analysis_wake_state,public.analysis_wake_permits from public,anon,authenticated,service_role;
grant select on public.analysis_wake_state,public.analysis_wake_permits to service_role;
-- The backend can claim/finish existing permits, but cannot create permits, change the target or enable a scheduler.
grant update(epoch,reset_at,failed_at,failure_code) on public.analysis_wake_state to service_role;
grant update(status,claim_token,claimed_at,worker_tick_id,completed_at) on public.analysis_wake_permits to service_role;

create function public.fail_analysis_wake(p_code text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_code is null or p_code not in ('worker_failed','claim_expired','worker_expired','transport_failed','transport_expired','observation_failed','enqueue_failed','queue_saturated') then raise exception 'invalid_wake_failure'; end if;
  perform 1 from public.analysis_wake_state where singleton for update;
  update public.analysis_wake_state set epoch=gen_random_uuid(),reset_at=clock_timestamp(),failed_at=clock_timestamp(),failure_code=p_code where singleton;
  update public.analysis_worker_state set health_epoch=gen_random_uuid(),health_reset_at=clock_timestamp(),last_tick_started_at=null,last_success_at=null,last_error=p_code where worker_name='scheduled-v1';
end $$;

create or replace function public.set_analysis_execution_mode(p_mode text)
returns void language plpgsql security invoker set search_path='' as $$
declare previous text;
begin
  if p_mode is null or p_mode not in ('disabled','interactive','scheduled','scheduled-wake') then raise exception 'invalid_execution_mode'; end if;
  select mode into previous from public.analysis_execution_policy where singleton for update;
  if not found then raise exception 'execution_policy_missing'; end if;
  if p_mode in ('interactive','scheduled-wake') and not public.analysis_processing_secure() then raise exception 'private_data_access_required'; end if;
  update public.analysis_execution_policy set mode=p_mode,updated_at=clock_timestamp() where singleton;
  if previous<>p_mode then
    update public.analysis_worker_state set health_epoch=gen_random_uuid(),health_reset_at=clock_timestamp(),last_tick_started_at=null,last_success_at=null,last_error='execution mode changed' where worker_name='scheduled-v1';
    update public.analysis_wake_state set epoch=gen_random_uuid(),reset_at=clock_timestamp(),last_enqueue_at=null,failed_at=null,failure_code='execution_mode_changed' where singleton;
  end if;
end $$;

create function public.configure_analysis_wake(p_enabled boolean,p_origin text,p_expect_processing boolean)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_enabled is null or p_expect_processing is null or (p_enabled and p_origin is null) then raise exception 'invalid_wake_config'; end if;
  if p_enabled and exists(select 1 from public.analysis_scheduler_transport_state where required and enabled) then raise exception 'other_scheduler_enabled'; end if;
  perform 1 from public.analysis_wake_state where singleton for update;
  update public.analysis_wake_state set enabled=p_enabled,origin=regexp_replace(p_origin,':443$',''),expect_processing=p_expect_processing,
    epoch=gen_random_uuid(),reset_at=clock_timestamp(),last_enqueue_at=null,failed_at=null,failure_code='waiting_for_private_completions' where singleton;
  update public.analysis_worker_state set health_epoch=gen_random_uuid(),health_reset_at=clock_timestamp(),last_tick_started_at=null,last_success_at=null,last_error='wake config changed' where worker_name='scheduled-v1';
end $$;

-- Root/Cron only: one permit per real minute, independent of HTTP request count or parameters.
create function public.issue_analysis_wake_permit()
returns uuid language plpgsql security invoker set search_path='' as $$
declare s public.analysis_wake_state%rowtype;t timestamptz:=clock_timestamp();v_id uuid;
begin
  select * into s from public.analysis_wake_state where singleton for update;
  if not s.enabled or not exists(select 1 from public.analysis_execution_policy where singleton and mode='scheduled-wake') then return null; end if;
  if exists(select 1 from public.analysis_wake_permits where slot=date_trunc('minute',t)) then return null; end if;
  if (select count(*) from public.analysis_wake_permits where status in ('pending','claimed') and epoch=s.epoch)>=8 then perform public.fail_analysis_wake('queue_saturated');return null; end if;
  if s.last_enqueue_at is not null and (s.last_enqueue_at<t-interval '2 minutes' or s.last_enqueue_at>t) then
    perform public.fail_analysis_wake('claim_expired');select * into s from public.analysis_wake_state where singleton;
  end if;
  insert into public.analysis_wake_permits(slot,epoch,issued_at,expires_at,processing_enabled)
    values(date_trunc('minute',t),s.epoch,t,t+interval '120 seconds',s.expect_processing) returning id into v_id;
  update public.analysis_wake_state set last_enqueue_at=t where singleton;
  delete from public.analysis_wake_permits where issued_at<t-interval '1 day' and status not in ('pending','claimed');
  return v_id;
end $$;

-- Backend only. The request supplies no permit ID; only a root-issued live permit can authorize a batch.
create function public.claim_analysis_wake(p_origin text,p_processing_enabled boolean)
returns table(permit_id uuid,claim_token uuid,worker_tick_id uuid) language plpgsql security invoker set search_path='' as $$
declare s public.analysis_wake_state%rowtype;p public.analysis_wake_permits%rowtype;v_token uuid;v_tick uuid;t timestamptz:=clock_timestamp();
begin
  select * into s from public.analysis_wake_state where singleton for update;
  if not s.enabled or p_origin is distinct from s.origin or p_processing_enabled is distinct from s.expect_processing
    or not exists(select 1 from public.analysis_execution_policy where singleton and mode='scheduled-wake') then return; end if;
  select * into p from public.analysis_wake_permits where epoch=s.epoch and status='pending' and expires_at>t and issued_at<=t order by issued_at limit 1 for update;
  if not found then return; end if;
  v_token:=gen_random_uuid();v_tick:=public.analysis_worker_tick_begin();
  update public.analysis_wake_permits set status='claimed',claim_token=v_token,claimed_at=t,worker_tick_id=v_tick where id=p.id;
  return query select p.id,v_token,v_tick;
end $$;

create function public.complete_analysis_wake(p_id uuid,p_claim_token uuid,p_success boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.analysis_wake_state%rowtype;p public.analysis_wake_permits%rowtype;v_ok boolean;t timestamptz:=clock_timestamp();
begin
  select * into s from public.analysis_wake_state where singleton for update;
  select * into p from public.analysis_wake_permits where id=p_id for update;
  if not found or p.claim_token is distinct from p_claim_token or p_claim_token is null then return false; end if;
  if p.status<>'claimed' then return p.status='succeeded' and p_success is true and p.epoch=s.epoch; end if;
  v_ok:=p_success is true and p.epoch=s.epoch and p.claimed_at<=t and p.claimed_at>t-interval '6 minutes' and exists(
    select 1 from public.analysis_worker_ticks w join public.analysis_worker_state st on st.health_epoch=w.health_epoch
    where st.worker_name='scheduled-v1' and w.id=p.worker_tick_id and w.succeeded=true and w.started_at>=p.issued_at and w.finished_at<=t
  );
  update public.analysis_wake_permits set status=case when v_ok then 'succeeded' else 'failed' end,completed_at=t where id=p.id;
  if not v_ok and p.epoch=s.epoch then perform public.fail_analysis_wake('worker_failed'); end if;
  return v_ok;
end $$;

-- Root observer only. A positive public HTTP response never creates a worker success.
create function public.observe_analysis_wake(p_id uuid,p_outcome text)
returns void language plpgsql security invoker set search_path='' as $$
declare s public.analysis_wake_state%rowtype;p public.analysis_wake_permits%rowtype;
begin
  if p_outcome is null or p_outcome not in ('accepted','failed','expired') then raise exception 'invalid_wake_observation'; end if;
  select * into s from public.analysis_wake_state where singleton for update;
  select * into p from public.analysis_wake_permits where id=p_id for update;
  if not found or p.transport_status<>'pending' then return; end if;
  update public.analysis_wake_permits set transport_status=p_outcome where id=p.id;
  if p_outcome<>'accepted' and p.epoch=s.epoch then
    perform public.fail_analysis_wake(case when p_outcome='expired' then 'transport_expired' else 'transport_failed' end);
  end if;
end $$;

create function public.expire_analysis_wake_permits()
returns integer language plpgsql security invoker set search_path='' as $$
declare s public.analysis_wake_state%rowtype;p public.analysis_wake_permits%rowtype;t timestamptz:=clock_timestamp();n integer:=0;
begin
  select * into s from public.analysis_wake_state where singleton for update;
  for p in select * from public.analysis_wake_permits where (status='pending' and expires_at<=t) or (status='claimed' and claimed_at<=t-interval '6 minutes') for update loop
    update public.analysis_wake_permits set status='expired',completed_at=t where id=p.id;n:=n+1;
    if p.epoch=s.epoch then
      perform public.fail_analysis_wake(case when p.status='pending' then 'claim_expired' else 'worker_expired' end);
      select * into s from public.analysis_wake_state where singleton;
    end if;
  end loop;return n;
end $$;

create function public.analysis_wake_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select public.analysis_processing_secure() and public.analysis_provider_available() and exists(
    select 1 from public.analysis_wake_state s
    join public.analysis_wake_permits a on a.epoch=s.epoch and a.status='succeeded' and a.transport_status='accepted' and a.processing_enabled
    join public.analysis_wake_permits b on b.epoch=s.epoch and b.status='succeeded' and b.transport_status='accepted' and b.processing_enabled
    join public.analysis_worker_ticks wa on wa.id=a.worker_tick_id and wa.succeeded=true
    join public.analysis_worker_ticks wb on wb.id=b.worker_tick_id and wb.succeeded=true
    join public.analysis_worker_state st on st.health_epoch=wa.health_epoch and st.health_epoch=wb.health_epoch
    where s.singleton and s.enabled and s.expect_processing and st.worker_name='scheduled-v1'
      and s.last_enqueue_at>now()-interval '2 minutes' and s.last_enqueue_at<=now()
      and a.issued_at>=s.reset_at and b.issued_at>=s.reset_at
      and a.issued_at>now()-interval '2 minutes' and a.issued_at<=now()
      and b.issued_at>now()-interval '3 minutes' and a.issued_at-b.issued_at>=interval '30 seconds'
      and wa.started_at>=a.issued_at and wb.started_at>=b.issued_at
      and wa.started_at-wb.started_at>=interval '30 seconds'
      and wa.finished_at<=now() and wb.finished_at<=now()
      and wa.finished_at>now()-interval '6 minutes' and wb.finished_at>now()-interval '6 minutes'
  );
$$;
create or replace function public.analysis_background_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select case (select mode from public.analysis_execution_policy where singleton)
    when 'interactive' then false -- User requires closed-screen completion; never enable this release path.
    when 'scheduled' then public.analysis_scheduled_ready()
    when 'scheduled-wake' then public.analysis_wake_ready()
    else false end;
$$;
create or replace function public.analysis_admission_ready(p_mode text)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(p_mode in ('scheduled','scheduled-wake') and p_mode=(select mode from public.analysis_execution_policy where singleton)
    and public.analysis_background_ready(),false);
$$;
revoke all on function public.configure_analysis_wake(boolean,text,boolean),public.issue_analysis_wake_permit(),public.observe_analysis_wake(uuid,text),public.expire_analysis_wake_permits() from public,anon,authenticated,service_role;
revoke all on function public.fail_analysis_wake(text),public.claim_analysis_wake(text,boolean),public.complete_analysis_wake(uuid,uuid,boolean),public.analysis_wake_ready() from public,anon,authenticated;
grant execute on function public.fail_analysis_wake(text),public.claim_analysis_wake(text,boolean),public.complete_analysis_wake(uuid,uuid,boolean),public.analysis_wake_ready() to service_role;
commit;
