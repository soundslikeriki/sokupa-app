-- INACTIVE CANDIDATE. Never add to automatic migrations. Apply only in an approved isolated environment.
-- Requires installed pg_net, Vault, pgcrypto. Creates no secrets and schedules no jobs.
begin;
create schema sokupa_ops;
revoke all on schema sokupa_ops from public,anon,authenticated,service_role;
create table sokupa_ops.scheduler_config(
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  origin text check(origin ~ '^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$'), secret_id uuid,
  expect_processing boolean not null default false
);
insert into sokupa_ops.scheduler_config(singleton) values(true);
create table sokupa_ops.dispatches(
  id uuid primary key,slot timestamptz not null unique,request_id bigint unique,
  expires_at timestamptz not null,response_deadline timestamptz not null,
  status text not null default 'pending',http_status integer,checked_at timestamptz
);
alter table sokupa_ops.scheduler_config enable row level security;
alter table sokupa_ops.dispatches enable row level security;
revoke all on all tables in schema sokupa_ops from public,anon,authenticated,service_role;

-- The scheduled DB owner invokes this fixed wrapper. No URL/key/header parameters or general proxy.
create function sokupa_ops.enqueue_dispatch()
returns bigint language plpgsql security invoker set search_path='' as $$
declare c sokupa_ops.scheduler_config%rowtype;v_id uuid:=gen_random_uuid();v_slot timestamptz;v_iat bigint;v_exp bigint;v_key text;v_message text;v_headers jsonb;v_request bigint;
begin
  select * into c from sokupa_ops.scheduler_config where singleton for update;
  if not c.enabled then return null; end if;
  if c.origin is null or c.secret_id is null then raise exception 'scheduler_not_configured'; end if;
  if (select count(*) from sokupa_ops.dispatches where status='pending')>=8 then return null; end if;
  v_slot:=date_trunc('minute',clock_timestamp());
  if exists(select 1 from sokupa_ops.dispatches where slot=v_slot) then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where id=c.secret_id;
  if v_key is null or octet_length(v_key)<32 then raise exception 'scheduler_key_unavailable'; end if;
  v_iat:=floor(extract(epoch from clock_timestamp()));v_exp:=v_iat+120;
  v_message:=concat_ws(E'\n','SOKUPA-DISPATCH-V1','GET',c.origin,'/api/analysis-jobs/process',v_id::text,v_iat::text,v_exp::text);
  v_headers:=jsonb_build_object('x-sokupa-dispatch-id',v_id::text,'x-sokupa-issued-at',v_iat::text,'x-sokupa-expires-at',v_exp::text,'x-sokupa-signature',encode(extensions.hmac(v_message,v_key,'sha256'),'hex'));
  insert into sokupa_ops.dispatches(id,slot,expires_at,response_deadline) values(v_id,v_slot,to_timestamp(v_exp),clock_timestamp()+interval '450 seconds');
  v_request:=net.http_get(url:=c.origin||'/api/analysis-jobs/process',headers:=v_headers,timeout_milliseconds:=310000);
  update sokupa_ops.dispatches set request_id=v_request where id=v_id;
  return v_request;
end $$;

-- SQL enqueue success is never HTTP success. A separate short cron call reconciles request IDs.
create function sokupa_ops.reconcile_dispatches()
returns integer language plpgsql security invoker set search_path='' as $$
declare d sokupa_ops.dispatches%rowtype;r record;b jsonb;v_status text;v_count integer:=0;v_expect boolean;
begin
  select expect_processing into v_expect from sokupa_ops.scheduler_config where singleton;
  for d in select * from sokupa_ops.dispatches where status='pending' order by slot for update skip locked loop
    select * into r from net._http_response where id=d.request_id order by created desc limit 1;
    if not found then
      if d.response_deadline>=clock_timestamp() then continue; end if;
      v_status:='expired';
    elsif r.created>d.response_deadline then v_status:='expired';
    elsif coalesce(r.timed_out,false) or r.error_msg is not null or r.status_code is distinct from 200 then v_status:='failed';
    else
      begin b:=r.content::jsonb;exception when others then b:=null;end;
      v_status:=case when b->'processing_enabled'=to_jsonb(v_expect) and b->>'processed' ~ '^[0-3]$' and coalesce(r.content_type,'') ilike '%application/json%' then 'succeeded' else 'invalid_response' end;
    end if;
    update sokupa_ops.dispatches set status=v_status,http_status=r.status_code,checked_at=clock_timestamp() where id=d.id;
    v_count:=v_count+1;
  end loop;
  delete from sokupa_ops.dispatches where status<>'pending' and slot<now()-interval '1 day';
  return v_count;
end $$;
revoke all on all functions in schema sokupa_ops from public,anon,authenticated,service_role;
commit;
-- NOT ACTIVATED. After explicit approval and isolated tests, configure the exact origin and existing
-- dedicated Vault secret ID, enable the row, and register exactly one enqueue+reconcile call/minute.
-- Never put the key, a protection bypass token, or service_role in cron.job or in URL query parameters.
-- Cron body must reconcile first, then enqueue; do not wait for HTTP in the DB transaction.
