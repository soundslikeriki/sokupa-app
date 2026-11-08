-- Local candidate only. Apply under disabled intake after all old workers drain.
-- No credentials, roles, scheduler, wake origin, mode or existing results are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table public.analysis_job_images
  add column pipeline_version integer check(pipeline_version=1),
  add column pipeline_checkpoint jsonb,
  add column provider_operation uuid,
  add column provider_stage text;

-- Explicit capability gate: new code never falls back to an unjournaled provider call.
create function public.analysis_pipeline_version() returns integer language sql stable security invoker set search_path='' as $$ select 1 $$;

create function public.begin_analysis_provider(p_image_id uuid,p_lease_token uuid,p_operation uuid,p_stage text,p_revision text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  if p_operation is null or p_stage is null or p_stage !~ '^(vision|catalog:[0-9]+)$' then raise exception 'invalid_provider_intent'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  perform 1 from public.analysis_job_images where id=p_image_id for update;
  update public.analysis_job_images set provider_operation=p_operation,provider_stage=p_stage,updated_at=clock_timestamp()
    where id=p_image_id and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
      and pipeline_version=1 and provider_operation is null
      and (pipeline_checkpoint->>'revision') is not distinct from p_revision;
  return found;
end $$;

create function public.checkpoint_analysis_image(p_image_id uuid,p_lease_token uuid,p_operation uuid,p_checkpoint jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  if p_checkpoint->>'version' is distinct from '1' or jsonb_typeof(p_checkpoint->'rawItems') is distinct from 'array' or jsonb_array_length(p_checkpoint->'rawItems')=0 or jsonb_typeof(p_checkpoint->'catalog') is distinct from 'object' or (p_checkpoint->>'revision') is null or octet_length(p_checkpoint::text)>2000000 then raise exception 'invalid_checkpoint'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  perform 1 from public.analysis_job_images where id=p_image_id for update;
  update public.analysis_job_images set pipeline_checkpoint=p_checkpoint,provider_operation=null,provider_stage=null,attempt_count=0,updated_at=clock_timestamp()
    where id=p_image_id and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
      and pipeline_version=1 and provider_operation is not distinct from p_operation;
  return found;
end $$;

-- A known-unstarted next stage can release early. Pending/unknown provider work cannot.
create function public.yield_analysis_image(p_image_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  perform 1 from public.analysis_job_images where id=p_image_id for update;
  update public.analysis_job_images set status='queued',lease_token=null,lease_expires_at=null,recovery_not_before=clock_timestamp(),attempt_count=0,updated_at=clock_timestamp()
    where id=p_image_id and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp() and pipeline_version=1 and provider_operation is null;
  return found;
end $$;

create or replace function public.defer_analysis_image(p_image_id uuid,p_lease_token uuid,p_code text,p_retryable boolean,p_retry_after_seconds integer default 0,p_delivery_unknown boolean default false)
returns text language plpgsql security invoker set search_path='' as $$
declare v_job uuid; v_image public.analysis_job_images%rowtype; v_retry boolean; v_delay integer; v_message text; v_refund integer;
begin
  if p_code is null or p_code not in ('rate_limit','upstream_unavailable','authentication','configuration','network','timeout') then raise exception 'invalid_failure_code'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return 'stale'; end if;
  select * into v_image from public.analysis_job_images where id=p_image_id for update;
  if not found or v_image.status<>'running' or p_lease_token is null or v_image.lease_token is distinct from p_lease_token or v_image.lease_expires_at is null or v_image.lease_expires_at<=clock_timestamp() then return 'stale'; end if;
  v_retry:=coalesce(p_retryable,false) and p_code in ('rate_limit','upstream_unavailable') and not coalesce(p_delivery_unknown,false) and v_image.attempt_count<3 and coalesce(p_retry_after_seconds,0)<=900;
  v_delay:=greatest(60*power(2,least(2,greatest(0,v_image.attempt_count-1)))::integer,least(900,greatest(0,coalesce(p_retry_after_seconds,0))))+floor(random()*16)::integer;
  v_message:=case when v_retry then '解析サービスが一時的に利用できません。待ち時間を置いて再試行します。'
    when p_code in ('network','timeout') then '解析サービスへの通信結果が不明なため自動再試行を停止しました。再解析では外部AIの料金が重なる可能性があります。'
    when p_code in ('authentication','configuration') then '解析サービスの設定を確認する必要があります。管理者へ連絡してください。'
    else '解析サービスの再試行上限に達したため停止しました。時間をおいて再度お試しください。' end;
  insert into public.analysis_provider_state(name,blocked_until,requires_admin,last_code) values('vision',case when v_retry then clock_timestamp()+make_interval(secs=>v_delay) else clock_timestamp()+interval '5 minutes' end,p_code in ('authentication','configuration'),p_code)
    on conflict(name) do update set blocked_until=greatest(public.analysis_provider_state.blocked_until,excluded.blocked_until),requires_admin=public.analysis_provider_state.requires_admin or excluded.requires_admin,last_code=excluded.last_code,updated_at=clock_timestamp();
  update public.analysis_job_images set provider_operation=case when coalesce(p_delivery_unknown,false) then provider_operation else null end,provider_stage=case when coalesce(p_delivery_unknown,false) then provider_stage else null end,status=case when v_retry then 'queued' else 'failed' end,error=v_message,failure_code=p_code,failure_delivery_unknown=coalesce(p_delivery_unknown,false),lease_token=null,lease_expires_at=null,recovery_not_before=clock_timestamp()+make_interval(secs=>v_delay),updated_at=clock_timestamp() where id=p_image_id;
  update public.analysis_jobs set status=case when v_retry then 'running' else 'failed' end,error=v_message,failure_kind='infrastructure',updated_at=clock_timestamp() where id=v_job;
  if v_retry then return 'queued'; end if;
  v_refund:=public.release_analysis_job_quota(v_job);
  if v_refund>0 then update public.analysis_jobs set error=error || ' 利用枠は返却済みです。' where id=v_job; end if;
  return 'failed';
end $$;


create or replace function public.complete_analysis_image(p_image_id uuid,p_lease_token uuid,p_parsed jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  if jsonb_typeof(p_parsed->'items') is distinct from 'array' or jsonb_array_length(p_parsed->'items')=0 then raise exception 'invalid_result'; end if;
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  perform 1 from public.analysis_job_images where id=p_image_id for update;
  update public.analysis_job_images i set status='done',parsed=p_parsed,error=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>clock_timestamp() and i.provider_operation is null;
  if not found then return false; end if;
  update public.analysis_jobs j set done_images=(select count(*) from public.analysis_job_images i where i.job_id=v_job and i.status='done'),updated_at=clock_timestamp() where j.id=v_job;
  return true;
end $$;

create or replace function public.fail_analysis_image(p_image_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  select job_id into v_job from public.analysis_job_images where id=p_image_id;
  perform 1 from public.analysis_jobs where id=v_job and status in ('queued','running') for update;
  if not found then return false; end if;
  perform 1 from public.analysis_job_images where id=p_image_id for update;
  update public.analysis_job_images i set status='failed',error=left(p_error,500),lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>clock_timestamp();
  if not found then return false; end if;
  update public.analysis_jobs set status='failed',failure_kind='job',error=left(p_error,500),updated_at=clock_timestamp() where id=v_job;
  return true;
end $$;


create function public.claim_durable_analysis_image(p_job_id uuid)
returns table(id uuid, idx integer, url text, lease_token uuid, attempt_count integer)
language plpgsql security invoker set search_path='' as $$
declare v_image public.analysis_job_images%rowtype;
begin
  if not public.analysis_provider_available() then return; end if;
  perform 1 from public.analysis_jobs j where j.id=p_job_id and j.status in ('queued','running') for update;
  if not found then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status in ('queued','running') and i.recovery_not_before>clock_timestamp()) then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status='running' and coalesce(i.lease_expires_at,i.updated_at+interval '6 minutes')>clock_timestamp()) then return; end if;
  select i.* into v_image from public.analysis_job_images i where i.job_id=p_job_id and (i.status='queued' or (i.status='running' and coalesce(i.lease_expires_at,i.updated_at+interval '6 minutes')<=clock_timestamp())) order by i.idx for update skip locked limit 1;
  if not found then return; end if;
  -- An expired operation may already have reached the provider. Never issue it twice.
  -- Pre-migration running rows have no trustworthy pre-send ledger either.
  if v_image.provider_operation is not null or (v_image.status='running' and v_image.pipeline_version is null) then
    update public.analysis_job_images i set status='failed',failure_code='network',failure_delivery_unknown=true,error='解析サービスへの通信結果が不明なため自動再試行を停止しました。再解析では外部AIの料金が重なる可能性があります。',lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where i.id=v_image.id;
    update public.analysis_jobs j set status='failed',failure_kind='infrastructure',error='解析サービスへの通信結果が不明なため自動再試行を停止しました。再解析では外部AIの料金が重なる可能性があります。',updated_at=clock_timestamp() where j.id=p_job_id;
    perform public.release_analysis_job_quota(p_job_id);
    return;
  end if;
  if v_image.attempt_count>=3 then
    update public.analysis_job_images i set status='failed',failure_code='worker_interrupted',error='解析の再開回数を超えました。',lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where i.id=v_image.id;
    update public.analysis_jobs j set status='failed',failure_kind='infrastructure',error='解析が繰り返し中断したため停止しました。',updated_at=clock_timestamp() where j.id=p_job_id;
    perform public.release_analysis_job_quota(p_job_id);
    return;
  end if;
  update public.analysis_jobs j set status='running',failure_kind=null,error=null,updated_at=clock_timestamp() where j.id=p_job_id;
  return query update public.analysis_job_images i set status='running',pipeline_version=1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '6 minutes',attempt_count=i.attempt_count+1,error=null,updated_at=clock_timestamp() where i.id=v_image.id returning i.id,i.idx,i.url,i.lease_token,i.attempt_count;
end $$;


-- Old application builds cannot acquire fresh leases after the protocol upgrade.
create or replace function public.claim_analysis_image(p_job_id uuid)
returns table(id uuid, idx integer, url text, lease_token uuid, attempt_count integer)
language plpgsql security invoker set search_path='' as $$
begin raise exception 'durable_worker_required'; end $$;

revoke all on function public.analysis_pipeline_version(),public.begin_analysis_provider(uuid,uuid,uuid,text,text),public.checkpoint_analysis_image(uuid,uuid,uuid,jsonb),public.yield_analysis_image(uuid,uuid),public.claim_durable_analysis_image(uuid) from public,anon,authenticated;
grant execute on function public.analysis_pipeline_version(),public.begin_analysis_provider(uuid,uuid,uuid,text,text),public.checkpoint_analysis_image(uuid,uuid,uuid,jsonb),public.yield_analysis_image(uuid,uuid),public.claim_durable_analysis_image(uuid) to service_role;
commit;
