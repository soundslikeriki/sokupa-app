-- INACTIVE. No secrets, extension ACL changes or Cron registration. Apply only in an approved environment.
-- Requires the private wake migration and installed pg_net. Target comes from root-only app configuration.
begin;
create schema if not exists sokupa_wake_ops;
revoke all on schema sokupa_wake_ops from public,anon,authenticated,service_role;
create table if not exists sokupa_wake_ops.requests(
  permit_id uuid primary key,request_id bigint,issued_at timestamptz not null default clock_timestamp(),
  deadline timestamptz not null default clock_timestamp()+interval '150 seconds',observed boolean not null default false
);
alter table sokupa_wake_ops.requests enable row level security;
revoke all on sokupa_wake_ops.requests from public,anon,authenticated,service_role;

create or replace function sokupa_wake_ops.reconcile()
returns void language plpgsql security invoker set search_path='' as $$
declare d sokupa_wake_ops.requests%rowtype;r record;v_outcome text;
begin
  for d in select * from sokupa_wake_ops.requests where not observed order by issued_at for update skip locked loop
    select * into r from net._http_response where id=d.request_id order by created desc limit 1;
    if not found then
      if clock_timestamp()<=d.deadline then continue; end if;v_outcome:='expired';
    elsif clock_timestamp()>d.deadline then v_outcome:='expired';
    elsif r.status_code=204 and not coalesce(r.timed_out,false) and r.error_msg is null and coalesce(r.content,'')='' then v_outcome:='accepted';
    else v_outcome:='failed';end if;
    perform public.observe_analysis_wake(d.permit_id,v_outcome);
    update sokupa_wake_ops.requests set observed=true where permit_id=d.permit_id;
  end loop;
  perform public.expire_analysis_wake_permits();
  delete from sokupa_wake_ops.requests where observed and issued_at<clock_timestamp()-interval '1 day';
exception when others then perform public.fail_analysis_wake('observation_failed');
end $$;

create or replace function sokupa_wake_ops.enqueue()
returns bigint language plpgsql security invoker set search_path='' as $$
declare v_id uuid;v_origin text;v_request bigint;
begin
  v_id:=public.issue_analysis_wake_permit();if v_id is null then return null;end if;
  select origin into v_origin from public.analysis_wake_state where singleton;
  -- Fixed empty request. No Authorization, apikey, signature, permit ID, user ID or result.
  v_request:=net.http_post(url:=v_origin||'/api/analysis-jobs/wake',body:='{}'::jsonb,headers:='{}'::jsonb,timeout_milliseconds:=10000);
  insert into sokupa_wake_ops.requests(permit_id,request_id) values(v_id,v_request);return v_request;
exception when others then perform public.fail_analysis_wake('enqueue_failed');return null;
end $$;
revoke all on all functions in schema sokupa_wake_ops from public,anon,authenticated,service_role;
commit;
-- After approval: configure target/mode, then schedule exactly one root call per minute:
-- select sokupa_wake_ops.reconcile();select sokupa_wake_ops.enqueue();
-- No Cron is created here. Do not use this template together with the signed scheduler candidate.
