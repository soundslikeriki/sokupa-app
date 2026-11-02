-- Phase 1: additive only. Apply to an isolated DB first, then production ONLY with approval.
-- This does not close existing browser access. Deploy the authenticated API client before Phase 2.
begin;
alter table public.analysis_jobs add column if not exists line_user_id text;
alter table public.analysis_jobs add column if not exists notification_status text not null default 'legacy_unknown';
alter table public.analysis_jobs alter column notification_status set default 'pending';
alter table public.analysis_jobs add column if not exists notification_attempted_at timestamptz;
alter table public.analysis_jobs add column if not exists notification_error text;
alter table public.analysis_jobs add column if not exists notified_at timestamptz;
create table if not exists public.memo_corrections (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  site_name text, kind text not null, before jsonb not null default '{}', after jsonb not null default '{}'
);
alter table public.memo_corrections add column if not exists line_user_id text;
alter table public.memo_corrections enable row level security;
revoke all on public.memo_corrections from public, anon, authenticated;
grant all on public.memo_corrections to service_role;
create function public.register_invited_line_user(p_line_user_id text, p_display_name text, p_picture_url text, p_invite_code text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  -- Serializes concurrent callbacks for one LINE identity; no second invitation is consumed.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_line_user_id, 0));
  if exists (select 1 from public.users where line_user_id = p_line_user_id) then return; end if;
  update public.invite_codes set is_used = true, used_at = now() where code = p_invite_code and is_used = false;
  if not found then raise exception 'invalid_invite'; end if;
  insert into public.users(line_user_id, display_name, picture_url, invite_code, last_login_at)
  values (p_line_user_id, p_display_name, p_picture_url, p_invite_code, now());
end $$;
revoke all on function public.register_invited_line_user(text,text,text,text) from public, anon, authenticated;
grant execute on function public.register_invited_line_user(text,text,text,text) to service_role;

create function public.create_analysis_job(p_line_user_id text, p_paths text[], p_site_name text, p_owner boolean default false)
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
  insert into public.analysis_jobs(line_user_id,site_name,total_images,context) values(p_line_user_id,p_site_name,array_length(p_paths,1),jsonb_build_object('site_name',p_site_name)) returning id into v_job;
  insert into public.analysis_job_images(job_id,idx,url) select v_job, ordinality - 1, path from unnest(p_paths) with ordinality paths(path,ordinality);
  return v_job;
end $$;
revoke all on function public.create_analysis_job(text,text[],text,boolean) from public, anon, authenticated;
grant execute on function public.create_analysis_job(text,text[],text,boolean) to service_role;
commit;
