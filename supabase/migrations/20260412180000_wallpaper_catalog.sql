-- 品番ごとの Google 検索カタログキャッシュ（API の service_role で upsert）
create table if not exists public.wallpaper_catalog (
  product_code text primary key,
  manufacturer text,
  spec text,
  repeat_info jsonb,
  notes text,
  confidence real,
  needs_review boolean default false,
  search_snippet text,
  updated_at timestamptz not null default now()
);

create index if not exists wallpaper_catalog_updated_at_idx
  on public.wallpaper_catalog (updated_at desc);

comment on table public.wallpaper_catalog is 'Gemini + Google Search によるカタログ情報のキャッシュ';
