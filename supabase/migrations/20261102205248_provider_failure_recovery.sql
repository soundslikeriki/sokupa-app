-- Additive, staged deployment only. Old reservations cannot safely be reconstructed.
begin;
alter table public.analysis_jobs
  add column failure_kind text,
  add column quota_tracking text not null default 'legacy_unknown',
  add column quota_month text,
  add column quota_reserved integer not null default 0 check(quota_reserved>=0),
  add column quota_refunded integer not null default 0 check(quota_refunded>=0 and quota_refunded<=quota_reserved);
alter table public.analysis_job_images
  add column failure_code text,
  add column failure_delivery_unknown boolean not null default false;
create table public.analysis_provider_state(
  name text primary key check(name='vision'), blocked_until timestamptz,
  requires_admin boolean not null default false, last_code text, updated_at timestamptz not null default now()
);
alter table public.analysis_provider_state enable row level security;
revoke all on public.analysis_provider_state from public,anon,authenticated;
grant all on public.analysis_provider_state to service_role;
create function public.analysis_provider_available()
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists(select 1 from public.analysis_provider_state where name='vision' and (requires_admin or blocked_until>now()));
$$;
create function public.clear_analysis_provider_block()
returns void language sql security invoker set search_path='' as $$
  update public.analysis_provider_state set requires_admin=false,blocked_until=null,updated_at=now() where name='vision';
$$;

-- Called inside the same transaction as terminal infrastructure failure. Job lock serializes refunds.
create function public.release_analysis_job_quota(p_job_id uuid)
returns integer language plpgsql security invoker set search_path='' as $$
declare v_job public.analysis_jobs%rowtype; v_refund integer;
begin
  select * into v_job from public.analysis_jobs where id=p_job_id for update;
  if not found or v_job.status<>'failed' or v_job.failure_kind is distinct from 'infrastructure' or v_job.quota_tracking<>'reserved-v1' then return 0; end if;
  v_refund:=v_job.quota_reserved-v_job.quota_refunded;
  if v_refund<=0 then return 0; end if;
  update public.usage_limits set image_count=greatest(0,coalesce(image_count,0)-v_refund),updated_at=now()
    where line_user_id=v_job.line_user_id and year_month=v_job.quota_month;
  if not found then raise exception 'quota_reservation_missing'; end if;
  update public.analysis_jobs set quota_refunded=quota_refunded+v_refund where id=p_job_id;
  return v_refund;
end $$;

create function public.defer_analysis_image(p_image_id uuid,p_lease_token uuid,p_code text,p_retryable boolean,p_retry_after_seconds integer default 0,p_delivery_unknown boolean default false)
returns text language plpgsql security invoker set search_path='' as $$
declare v_job uuid; v_image public.analysis_job_images%rowtype; v_retry boolean; v_delay integer; v_message text; v_refund integer;
begin
  if p_code is null or p_code not in ('rate_limit','upstream_unavailable','authentication','configuration','network','timeout') then raise exception 'invalid_failure_code'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return 'stale'; end if;
  select * into v_image from public.analysis_job_images where id=p_image_id for update;
  if not found or v_image.status<>'running' or p_lease_token is null or v_image.lease_token is distinct from p_lease_token or v_image.lease_expires_at is null or v_image.lease_expires_at<=now() then return 'stale'; end if;
  v_retry:=coalesce(p_retryable,false) and p_code in ('rate_limit','upstream_unavailable') and not coalesce(p_delivery_unknown,false) and v_image.attempt_count<3 and coalesce(p_retry_after_seconds,0)<=900;
  v_delay:=greatest(60*power(2,least(2,greatest(0,v_image.attempt_count-1)))::integer,least(900,greatest(0,coalesce(p_retry_after_seconds,0))))+floor(random()*16)::integer;
  v_message:=case when v_retry then '解析サービスが一時的に利用できません。待ち時間を置いて再試行します。'
    when p_code in ('network','timeout') then '解析サービスへの通信結果が不明なため自動再試行を停止しました。再解析では外部AIの料金が重なる可能性があります。'
    when p_code in ('authentication','configuration') then '解析サービスの設定を確認する必要があります。管理者へ連絡してください。'
    else '解析サービスの再試行上限に達したため停止しました。時間をおいて再度お試しください。' end;
  insert into public.analysis_provider_state(name,blocked_until,requires_admin,last_code) values('vision',case when v_retry then now()+make_interval(secs=>v_delay) else now()+interval '5 minutes' end,p_code in ('authentication','configuration'),p_code)
    on conflict(name) do update set blocked_until=greatest(public.analysis_provider_state.blocked_until,excluded.blocked_until),requires_admin=public.analysis_provider_state.requires_admin or excluded.requires_admin,last_code=excluded.last_code,updated_at=now();
  update public.analysis_job_images set status=case when v_retry then 'queued' else 'failed' end,error=v_message,failure_code=p_code,failure_delivery_unknown=coalesce(p_delivery_unknown,false),lease_token=null,lease_expires_at=null,recovery_not_before=now()+make_interval(secs=>v_delay),updated_at=now() where id=p_image_id;
  update public.analysis_jobs set status=case when v_retry then 'running' else 'failed' end,error=v_message,failure_kind='infrastructure',updated_at=now() where id=v_job;
  if v_retry then return 'queued'; end if;
  v_refund:=public.release_analysis_job_quota(v_job);
  if v_refund>0 then update public.analysis_jobs set error=error || ' 利用枠は返却済みです。' where id=v_job; end if;
  return 'failed';
end $$;

create or replace function public.claim_analysis_image(p_job_id uuid)
returns table(id uuid, idx integer, url text, lease_token uuid, attempt_count integer)
language plpgsql security invoker set search_path='' as $$
declare v_image public.analysis_job_images%rowtype;
begin
  if not public.analysis_provider_available() then return; end if;
  perform 1 from public.analysis_jobs j where j.id=p_job_id and j.status in ('queued','running') for update;
  if not found then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status in ('queued','running') and i.recovery_not_before>now()) then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status='running' and coalesce(i.lease_expires_at,i.updated_at+interval '6 minutes')>now()) then return; end if;
  select i.* into v_image from public.analysis_job_images i where i.job_id=p_job_id and (i.status='queued' or (i.status='running' and coalesce(i.lease_expires_at,i.updated_at+interval '6 minutes')<=now())) order by i.idx for update skip locked limit 1;
  if not found then return; end if;
  if v_image.attempt_count>=3 then
    update public.analysis_job_images i set status='failed',failure_code='worker_interrupted',error='解析の再開回数を超えました。',lease_token=null,lease_expires_at=null,updated_at=now() where i.id=v_image.id;
    update public.analysis_jobs j set status='failed',failure_kind='infrastructure',error='解析が繰り返し中断したため停止しました。',updated_at=now() where j.id=p_job_id;
    perform public.release_analysis_job_quota(p_job_id);
    return;
  end if;
  update public.analysis_jobs j set status='running',failure_kind=null,error=null,updated_at=now() where j.id=p_job_id;
  return query update public.analysis_job_images i set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '6 minutes',attempt_count=i.attempt_count+1,error=null,updated_at=now() where i.id=v_image.id returning i.id,i.idx,i.url,i.lease_token,i.attempt_count;
end $$;

-- Match claim/defer lock order, so completion cannot deadlock against quota settlement.
create or replace function public.complete_analysis_image(p_image_id uuid,p_lease_token uuid,p_parsed jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  if jsonb_typeof(p_parsed->'items') is distinct from 'array' or jsonb_array_length(p_parsed->'items')=0 then raise exception 'invalid_result'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  update public.analysis_job_images i set status='done',parsed=p_parsed,error=null,lease_token=null,lease_expires_at=null,updated_at=now()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>now();
  if not found then return false; end if;
  update public.analysis_jobs j set done_images=(select count(*) from public.analysis_job_images i where i.job_id=v_job and i.status='done'),updated_at=now() where j.id=v_job;
  return true;
end $$;
create or replace function public.fail_analysis_image(p_image_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  update public.analysis_job_images i set status='failed',error=left(p_error,500),lease_token=null,lease_expires_at=null,updated_at=now()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>now();
  if not found then return false; end if;
  update public.analysis_jobs set status='failed',failure_kind='job',error=left(p_error,500),updated_at=now() where id=v_job;
  return true;
end $$;

create or replace function public.create_analysis_job(p_line_user_id text,p_paths text[],p_site_name text,p_owner boolean default false)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_job uuid;v_count integer;v_reserved integer:=0;v_month text:=to_char(now() at time zone 'Asia/Tokyo','YYYY-MM');
begin
  if coalesce(array_length(p_paths,1),0)<1 or array_length(p_paths,1)>5 then raise exception 'invalid_images'; end if;
  if not exists(select 1 from public.users where line_user_id=p_line_user_id) then raise exception 'invalid_user'; end if;
  if exists(select 1 from unnest(p_paths) path where path is null or path not like p_line_user_id || '/%') then raise exception 'invalid_images'; end if;
  if not public.analysis_background_ready() then raise exception 'worker_unavailable'; end if;
  if not p_owner and not exists(select 1 from public.unlimited_users where line_user_id=p_line_user_id) then
    v_reserved:=array_length(p_paths,1);
    insert into public.usage_limits(line_user_id,year_month,image_count,updated_at) values(p_line_user_id,v_month,v_reserved,now())
      on conflict(line_user_id,year_month) do update set image_count=coalesce(public.usage_limits.image_count,0)+excluded.image_count,updated_at=now() where coalesce(public.usage_limits.image_count,0)+excluded.image_count<=20 returning image_count into v_count;
    if v_count is null then raise exception 'monthly_limit'; end if;
  end if;
  insert into public.analysis_jobs(line_user_id,site_name,total_images,context,notification_status,notification_protocol,quota_tracking,quota_month,quota_reserved)
    values(p_line_user_id,p_site_name,array_length(p_paths,1),jsonb_build_object('site_name',p_site_name),'pending','line_retry_v1','reserved-v1',case when v_reserved>0 then v_month end,v_reserved) returning id into v_job;
  insert into public.analysis_job_images(job_id,idx,url,recovery_not_before) select v_job,ordinality-1,path,now() from unnest(p_paths) with ordinality paths(path,ordinality);
  return v_job;
end $$;

-- Keep the verified two-completion predicate; an unhealthy provider is an additional intake gate.
create or replace function public.analysis_background_ready()
returns boolean language sql stable security invoker set search_path='' as $$
  select public.analysis_processing_secure() and public.analysis_provider_available() and exists(
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
revoke all on function public.analysis_provider_available(),public.clear_analysis_provider_block(),public.release_analysis_job_quota(uuid),public.defer_analysis_image(uuid,uuid,text,boolean,integer,boolean) from public,anon,authenticated;
grant execute on function public.analysis_provider_available(),public.clear_analysis_provider_block(),public.release_analysis_job_quota(uuid),public.defer_analysis_image(uuid,uuid,text,boolean,integer,boolean) to service_role;
commit;
