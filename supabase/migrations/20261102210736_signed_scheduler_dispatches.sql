-- Replay guard only. Does not create a key, enable cron, or expose a deployment.
begin;
create table public.analysis_scheduler_dispatches(id uuid primary key,issued_at timestamptz not null,expires_at timestamptz not null,claimed_at timestamptz not null default now());
create index analysis_scheduler_dispatches_expiry on public.analysis_scheduler_dispatches(expires_at);
alter table public.analysis_scheduler_dispatches enable row level security;
revoke all on public.analysis_scheduler_dispatches from public,anon,authenticated;
grant all on public.analysis_scheduler_dispatches to service_role;
create function public.claim_analysis_dispatch(p_id uuid,p_issued_at bigint,p_expires_at bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_now numeric:=extract(epoch from clock_timestamp());v_id uuid;
begin
  if p_id is null or p_issued_at is null or p_expires_at is null or p_issued_at>v_now+15 or p_issued_at<v_now-120 or p_expires_at<=v_now or p_expires_at-p_issued_at<1 or p_expires_at-p_issued_at>120 then return false; end if;
  insert into public.analysis_scheduler_dispatches(id,issued_at,expires_at) values(p_id,to_timestamp(p_issued_at),to_timestamp(p_expires_at)) on conflict(id) do nothing returning id into v_id;
  delete from public.analysis_scheduler_dispatches where expires_at<now()-interval '1 day';
  return v_id is not null;
end $$;
revoke all on function public.claim_analysis_dispatch(uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.claim_analysis_dispatch(uuid,bigint,bigint) to service_role;
commit;
