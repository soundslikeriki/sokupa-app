-- INACTIVE CANDIDATE. Never add to automatic migrations. Apply only in an approved isolated environment.
-- Requires installed pg_net, Vault, pgcrypto. Creates no secrets and schedules no jobs.
begin;
create schema if not exists sokupa_ops;
revoke all on schema sokupa_ops from public,anon,authenticated,service_role;
create table if not exists sokupa_ops.scheduler_config(
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  origin text, secret_id uuid,
  expect_processing boolean not null default false
);
-- Explicit ports allow an isolated non-root TLS worker. The full origin remains signed and fixed.
alter table sokupa_ops.scheduler_config drop constraint if exists scheduler_config_origin_check;
alter table sokupa_ops.scheduler_config add constraint scheduler_config_origin_check check(
  origin ~ '^https://[a-z0-9][a-z0-9.-]*[a-z0-9](:[1-9][0-9]{0,4})?$'
  and coalesce(substring(origin from ':([0-9]+)$')::numeric,443) between 1 and 65535
);
insert into sokupa_ops.scheduler_config(singleton) values(true) on conflict(singleton) do nothing;
create table if not exists sokupa_ops.dispatches(
  id uuid primary key,slot timestamptz not null unique,request_id bigint,
  expires_at timestamptz not null,response_deadline timestamptz not null,
  status text not null default 'pending',http_status integer,checked_at timestamptz
);
-- pg_net's UNLOGGED sequence can restart after a crash. A request ID is not globally unique.
alter table sokupa_ops.dispatches drop constraint if exists dispatches_request_id_key;
create index if not exists dispatches_request_lookup on sokupa_ops.dispatches(request_id);
alter table sokupa_ops.scheduler_config enable row level security;
alter table sokupa_ops.dispatches enable row level security;
revoke all on all tables in schema sokupa_ops from public,anon,authenticated,service_role;

-- pg_net ships broad default table grants. This candidate must not activate on those defaults.
-- Do not revoke a shared production extension here; its owner must review other consumers first.
create or replace function sokupa_ops.extensions_private()
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists(
    select 1 from unnest(array['anon','authenticated','service_role']) r
    cross join unnest(array['net.http_request_queue','net._http_response','vault.secrets','vault.decrypted_secrets']) t
    where to_regclass(t) is null
      or coalesce(has_table_privilege(r,to_regclass(t),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),true)
      or coalesce(has_any_column_privilege(r,to_regclass(t),'SELECT,INSERT,UPDATE'),true)
  );
$$;

-- The scheduled DB owner invokes this fixed wrapper. No URL/key/header parameters or general proxy.
create or replace function sokupa_ops.enqueue_dispatch()
returns bigint language plpgsql security invoker set search_path='' as $$
declare c sokupa_ops.scheduler_config%rowtype;v_id uuid:=gen_random_uuid();v_slot timestamptz;v_iat bigint;v_exp bigint;v_key text;v_message text;v_headers jsonb;v_request bigint;
begin
  select * into c from sokupa_ops.scheduler_config where singleton for update;
  if not c.enabled then return null; end if;
  if not sokupa_ops.extensions_private() then raise exception 'scheduler_extension_permissions_open'; end if;
  if c.origin is null or c.secret_id is null then raise exception 'scheduler_not_configured'; end if;
  if (select count(*) from sokupa_ops.dispatches where status='pending')>=8 then perform public.fail_analysis_transport('queue_saturated');return null; end if;
  v_slot:=date_trunc('minute',clock_timestamp());
  if exists(select 1 from sokupa_ops.dispatches where slot=v_slot) then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where id=c.secret_id;
  if v_key is null or octet_length(v_key)<32 then raise exception 'scheduler_key_unavailable'; end if;
  v_iat:=floor(extract(epoch from clock_timestamp()));v_exp:=v_iat+120;
  v_message:=concat_ws(E'\n','SOKUPA-DISPATCH-V1','GET',c.origin,'/api/analysis-jobs/process',v_id::text,v_iat::text,v_exp::text);
  v_headers:=jsonb_build_object('x-sokupa-dispatch-id',v_id::text,'x-sokupa-issued-at',v_iat::text,'x-sokupa-expires-at',v_exp::text,'x-sokupa-signature',encode(extensions.hmac(v_message,v_key,'sha256'),'hex'));
  perform public.begin_analysis_transport_dispatch(v_id,v_iat,v_exp);
  insert into sokupa_ops.dispatches(id,slot,expires_at,response_deadline) values(v_id,v_slot,to_timestamp(v_exp),clock_timestamp()+interval '450 seconds');
  v_request:=net.http_get(url:=c.origin||'/api/analysis-jobs/process',headers:=v_headers,timeout_milliseconds:=310000);
  update sokupa_ops.dispatches set request_id=v_request where id=v_id;
  return v_request;
exception when others then
  -- Raising here would roll back the failure flag too. Persist the closed gate and return no ID.
  perform public.fail_analysis_transport('enqueue_failed');return null;
end $$;

-- SQL enqueue success is never HTTP success. A separate short cron call reconciles request IDs.
create or replace function sokupa_ops.reconcile_dispatches()
returns integer language plpgsql security invoker set search_path='' as $$
declare d sokupa_ops.dispatches%rowtype;r record;b jsonb;v_status text;v_count integer:=0;v_expect boolean;v_tick uuid;
begin
  select expect_processing into v_expect from sokupa_ops.scheduler_config where singleton;
  for d in select * from sokupa_ops.dispatches where status='pending' order by slot for update skip locked loop
    v_tick:=null;b:=null;
    select * into r from net._http_response where id=d.request_id order by created desc limit 1;
    if not found then
      if d.response_deadline>=clock_timestamp() then continue; end if;
      v_status:='expired';
    -- pg_net 0.20 records created=now() in a transaction started BEFORE its HTTP batch.
    -- Use the observer's clock for the deadline, never mistake that batch start for completion.
    elsif clock_timestamp()>d.response_deadline then v_status:='expired';
    elsif coalesce(r.timed_out,false) or r.error_msg is not null or r.status_code is distinct from 200 then v_status:='failed';
    else
      begin b:=r.content::jsonb;exception when others then b:=null;end;
      v_status:='invalid_response';
      if b->'processing_enabled'=to_jsonb(v_expect) and b->>'processed' ~ '^[0-3]$' and b->>'dispatch_id'=d.id::text and coalesce(r.content_type,'') ilike '%application/json%' then
        begin v_tick:=(b->>'worker_tick_id')::uuid;exception when others then v_tick:=null;end;
        if v_tick is not null then v_status:='succeeded'; end if;
      end if;
    end if;
    perform public.record_analysis_transport_result(d.id,v_status,v_tick,clock_timestamp());
    select outcome into v_status from public.analysis_scheduler_transport_attempts where id=d.id;
    if not found then v_status:='invalid_response'; end if;
    update sokupa_ops.dispatches set status=v_status,http_status=r.status_code,checked_at=clock_timestamp() where id=d.id;
    v_count:=v_count+1;
  end loop;
  delete from sokupa_ops.dispatches where status<>'pending' and slot<now()-interval '1 day';
  return v_count;
exception when others then
  perform public.fail_analysis_transport('observation_failed');return 0;
end $$;

create or replace function sokupa_ops.scheduler_config_changed()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.enabled and not sokupa_ops.extensions_private() then raise exception 'scheduler_extension_permissions_open'; end if;
  perform public.configure_analysis_transport(new.enabled);return new;
end $$;
drop trigger if exists scheduler_config_changed on sokupa_ops.scheduler_config;
create trigger scheduler_config_changed after update of enabled,origin,secret_id,expect_processing on sokupa_ops.scheduler_config for each row execute function sokupa_ops.scheduler_config_changed();
-- Reapplying upgrades the older template without copying keys or accepting its previous successes.
update sokupa_ops.scheduler_config set enabled=false where enabled and not sokupa_ops.extensions_private();
select public.configure_analysis_transport(enabled) from sokupa_ops.scheduler_config where singleton;
revoke all on all functions in schema sokupa_ops from public,anon,authenticated,service_role;
commit;
-- NOT ACTIVATED. After explicit approval and isolated tests, configure the exact origin and existing
-- dedicated Vault secret ID, enable the row, and register exactly one enqueue+reconcile call/minute.
-- Never put the key, a protection bypass token, or service_role in cron.job or in URL query parameters.
-- Cron body must reconcile first, then enqueue; do not wait for HTTP in the DB transaction.
