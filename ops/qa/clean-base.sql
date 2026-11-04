-- QA ONLY. Empty public schema, no source dump/rows/keys. Then apply the twelve 202611 migrations.
begin;
do $$ begin
  if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) then
    raise exception 'qa_requires_empty_public_schema';
  end if;
end $$;
create table public.sokupa_qa_bootstrap(singleton boolean primary key default true check(singleton),version integer not null check(version=1),created_at timestamptz not null default clock_timestamp());
insert into public.sokupa_qa_bootstrap(singleton,version)values(true,1);
alter table public.sokupa_qa_bootstrap enable row level security;
revoke all on public.sokupa_qa_bootstrap from public,anon,authenticated,service_role;
create table public.users(line_user_id text primary key, display_name text, picture_url text, invite_code text, created_at timestamptz not null default now(), last_login_at timestamptz);
create table public.invite_codes(id uuid primary key default gen_random_uuid(),code text unique not null,is_used boolean not null default false,created_at timestamptz not null default now(),used_at timestamptz);
create table public.unlimited_users(id uuid primary key default gen_random_uuid(),line_user_id text unique not null);
create table public.usage_limits(id uuid primary key default gen_random_uuid(),line_user_id text not null,year_month text not null,image_count integer not null default 0,updated_at timestamptz default now(),unique(line_user_id,year_month));
create table public.analysis_jobs(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),line_user_id text,status text not null default 'queued',site_name text,context jsonb not null default '{}',total_images integer not null default 0,done_images integer not null default 0,result jsonb,error text);
create table public.analysis_job_images(id uuid primary key default gen_random_uuid(),job_id uuid not null references public.analysis_jobs(id) on delete cascade,idx integer not null,url text not null,status text not null default 'queued',parsed jsonb,error text,created_at timestamptz default now(),updated_at timestamptz default now(),unique(job_id,idx));
create index analysis_jobs_created_at_idx on public.analysis_jobs(created_at desc);
create index analysis_jobs_status_idx on public.analysis_jobs(status);
create table public.ocr_order_cache(product_code text primary key,result jsonb not null,updated_at timestamptz not null default now());
create table public.memo_jobs(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),line_user_id text,result jsonb);
create table public.manufacturers(id uuid primary key default gen_random_uuid(),name text not null,code_prefix text[],created_at timestamptz default now());
create table public.catalogs(id uuid primary key default gen_random_uuid(),manufacturer_id uuid references public.manufacturers(id),name text not null,title text,valid_from date,valid_to date,source_pdf_path text,created_at timestamptz default now());
create table public.wallpapers(code text primary key,manufacturer_id uuid references public.manufacturers(id),catalog_id uuid references public.catalogs(id),spec text,repeat_v text,repeat_h text,pattern_match text,notes text,catalog_page_num integer,pdf_segment_path text,is_live_searched boolean default false,source_url text,confidence real,updated_at timestamptz default now());
do $$ declare t text; begin
  foreach t in array array['users','invite_codes','unlimited_users','usage_limits','analysis_jobs','analysis_job_images','ocr_order_cache','memo_jobs','manufacturers','catalogs','wallpapers'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('memo_uploads','memo_uploads',false,4194304,array['image/jpeg','image/png','image/webp']);
commit;
