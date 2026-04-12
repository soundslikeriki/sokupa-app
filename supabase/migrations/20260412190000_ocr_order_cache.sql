-- OCR 経路の品番ごと解析キャッシュ（/api/order-from-ocr）
create table if not exists public.ocr_order_cache (
  product_code text primary key,
  result jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists ocr_order_cache_updated_at_idx
  on public.ocr_order_cache (updated_at desc);

comment on table public.ocr_order_cache is 'order-from-ocr: 品番ごとの検索・解析結果キャッシュ';
