-- Additive Phase 1 migration. No production execution without approval.
begin;
-- Existing/legacy writers get a one-time grace period so old 300s invocations can drain.
alter table public.analysis_job_images add column if not exists recovery_not_before timestamptz not null default (now() + interval '6 minutes');
alter table public.analysis_job_images add column if not exists lease_token uuid;
alter table public.analysis_job_images add column if not exists lease_expires_at timestamptz;
alter table public.analysis_job_images add column if not exists attempt_count integer not null default 0;

-- One active image per job. Locks, expiry and fencing are decided by DB time.
create function public.claim_analysis_image(p_job_id uuid)
returns table(id uuid, idx integer, url text, lease_token uuid, attempt_count integer)
language plpgsql security invoker set search_path='' as $$
declare v_image public.analysis_job_images%rowtype;
begin
  perform 1 from public.analysis_jobs j where j.id=p_job_id and j.status in ('queued','running') for update;
  if not found then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status in ('queued','running') and i.recovery_not_before>now()) then return; end if;
  if exists(select 1 from public.analysis_job_images i where i.job_id=p_job_id and i.status='running'
      and coalesce(i.lease_expires_at,i.updated_at + interval '6 minutes') > now()) then return; end if;
  select i.* into v_image from public.analysis_job_images i where i.job_id=p_job_id and
    (i.status='queued' or (i.status='running' and coalesce(i.lease_expires_at,i.updated_at + interval '6 minutes') <= now()))
    order by i.idx for update skip locked limit 1;
  if not found then return; end if;
  if v_image.attempt_count >= 3 then
    update public.analysis_job_images i set status='failed',error='解析の再開回数を超えました。画像を確認して再解析してください。',lease_token=null,lease_expires_at=null,updated_at=now() where i.id=v_image.id;
    update public.analysis_jobs j set status='failed',error='解析が繰り返し中断しました。画像を確認して再解析してください。',updated_at=now() where j.id=p_job_id;
    return;
  end if;
  update public.analysis_jobs j set status='running',updated_at=now() where j.id=p_job_id;
  return query update public.analysis_job_images i set status='running',lease_token=gen_random_uuid(),
    lease_expires_at=now() + interval '6 minutes',attempt_count=i.attempt_count+1,error=null,updated_at=now()
    where i.id=v_image.id returning i.id,i.idx,i.url,i.lease_token,i.attempt_count;
end $$;

create function public.complete_analysis_image(p_image_id uuid,p_lease_token uuid,p_parsed jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  if jsonb_typeof(p_parsed->'items') is distinct from 'array' or jsonb_array_length(p_parsed->'items')=0 then raise exception 'invalid_result'; end if;
  update public.analysis_job_images i set status='done',parsed=p_parsed,error=null,lease_token=null,lease_expires_at=null,updated_at=now()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>now()
      and exists(select 1 from public.analysis_jobs j where j.id=i.job_id and j.status in ('queued','running'))
    returning i.job_id into v_job;
  if not found then return false; end if;
  update public.analysis_jobs j set done_images=(select count(*) from public.analysis_job_images i where i.job_id=v_job and i.status='done'),updated_at=now() where j.id=v_job;
  return true;
end $$;

create function public.fail_analysis_image(p_image_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_job uuid;
begin
  update public.analysis_job_images i set status='failed',error=left(p_error,500),lease_token=null,lease_expires_at=null,updated_at=now()
    where i.id=p_image_id and i.status='running' and i.lease_token=p_lease_token and i.lease_expires_at>now()
    returning i.job_id into v_job;
  if not found then return false; end if;
  update public.analysis_jobs j set status='failed',error=left(p_error,500),updated_at=now() where j.id=v_job and j.status in ('queued','running');
  return true;
end $$;

create function public.resumable_analysis_jobs()
returns table(id uuid) language sql security invoker set search_path='' as $$
  select j.id from public.analysis_jobs j where
    (j.status in ('queued','running') and not exists(select 1 from public.analysis_job_images i where i.job_id=j.id and ((i.status='running' and coalesce(i.lease_expires_at,i.updated_at + interval '6 minutes')>now()) or (i.status in ('queued','running') and i.recovery_not_before>now()))))
    or (j.status='done' and j.notification_status in ('pending','failed'))
  order by j.updated_at limit 3;
$$;
create or replace function public.create_analysis_job(p_line_user_id text, p_paths text[], p_site_name text, p_owner boolean default false)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_job uuid; v_count integer; v_month text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM');
begin
  if coalesce(array_length(p_paths, 1),0) < 1 or array_length(p_paths,1) > 5 then raise exception 'invalid_images'; end if;
  if not exists(select 1 from public.users where line_user_id = p_line_user_id) then raise exception 'invalid_user'; end if;
  if exists(select 1 from unnest(p_paths) path where path is null or path not like p_line_user_id || '/%') then raise exception 'invalid_images'; end if;
  if not p_owner and not exists(select 1 from public.unlimited_users where line_user_id = p_line_user_id) then
    insert into public.usage_limits(line_user_id, year_month, image_count, updated_at)
    values(p_line_user_id, v_month, array_length(p_paths,1), now())
    on conflict(line_user_id, year_month) do update
      set image_count = coalesce(public.usage_limits.image_count,0) + excluded.image_count, updated_at = now()
      where coalesce(public.usage_limits.image_count,0) + excluded.image_count <= 20
    returning image_count into v_count;
    if v_count is null then raise exception 'monthly_limit'; end if;
  end if;
  insert into public.analysis_jobs(line_user_id,site_name,total_images,context,notification_status) values(p_line_user_id,p_site_name,array_length(p_paths,1),jsonb_build_object('site_name',p_site_name),'pending') returning id into v_job;
  insert into public.analysis_job_images(job_id,idx,url,recovery_not_before) select v_job, ordinality - 1, path, now() from unnest(p_paths) with ordinality paths(path,ordinality);
  return v_job;
end $$;
revoke all on function public.claim_analysis_image(uuid),public.complete_analysis_image(uuid,uuid,jsonb),public.fail_analysis_image(uuid,uuid,text),public.resumable_analysis_jobs() from public,anon,authenticated;
grant execute on function public.claim_analysis_image(uuid),public.complete_analysis_image(uuid,uuid,jsonb),public.fail_analysis_image(uuid,uuid,text),public.resumable_analysis_jobs() to service_role;
commit;
