-- QA ONLY, after clean-base + migrations + disabled Phase2/seal. No implicit owner or expiry.
begin;
do $$ begin
 if to_regclass('public.sokupa_qa_bootstrap') is null then raise exception 'qa_bootstrap_required';end if;
 if not exists(select 1 from public.sokupa_qa_bootstrap where singleton and version=1) then raise exception 'qa_bootstrap_required';end if;
end $$;
create table public.sokupa_qa_limits(
 singleton boolean primary key default true check(singleton),
 owner_line_user_id text not null check(owner_line_user_id ~ '^U[a-f0-9]{32}$'),
 issued_at timestamptz not null,expires_at timestamptz not null,
 jobs integer not null default 0,images integer not null default 0,
 uploads integer not null default 0,upload_bytes bigint not null default 0,
 check(expires_at>issued_at and expires_at<=issued_at+interval '90 minutes')
);
alter table public.sokupa_qa_limits enable row level security;
revoke all on public.sokupa_qa_limits from public,anon,authenticated,service_role;
grant select on public.sokupa_qa_limits to service_role;
grant update(jobs,images,uploads,upload_bytes) on public.sokupa_qa_limits to service_role;
create function public.reserve_qa_upload(p_owner text,p_bytes integer) returns boolean
language plpgsql security invoker set search_path='' as $$
declare c public.sokupa_qa_limits%rowtype;
begin
 select * into c from public.sokupa_qa_limits where singleton for update;
 if not found or c.owner_line_user_id is distinct from p_owner or clock_timestamp()<c.issued_at or clock_timestamp()>=c.expires_at or p_bytes is null or p_bytes<4 or p_bytes>4194304 or c.uploads>=40 or c.upload_bytes+p_bytes>83886080 then return false;end if;
 update public.sokupa_qa_limits set uploads=uploads+1,upload_bytes=upload_bytes+p_bytes where singleton;
 return true;
end $$;
revoke all on function public.reserve_qa_upload(text,integer) from public,anon,authenticated;
grant execute on function public.reserve_qa_upload(text,integer) to service_role;
create function public.enforce_qa_job_limit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare c public.sokupa_qa_limits%rowtype;
begin
 select * into c from public.sokupa_qa_limits where singleton for update;
 if not found or c.owner_line_user_id is distinct from new.line_user_id or clock_timestamp()<c.issued_at or clock_timestamp()>=c.expires_at or new.total_images is null or new.total_images<1 or new.total_images>5 or c.jobs>=10 or c.images+new.total_images>20 then raise exception 'qa_limit_or_expiry';end if;
 update public.sokupa_qa_limits set jobs=jobs+1,images=images+new.total_images where singleton;
 return new;
end $$;
revoke all on function public.enforce_qa_job_limit() from public,anon,authenticated;
grant execute on function public.enforce_qa_job_limit() to service_role;
create trigger qa_job_budget before insert on public.analysis_jobs for each row execute function public.enforce_qa_job_limit();
commit;
