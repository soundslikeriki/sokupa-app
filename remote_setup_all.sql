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


-- ================================ --

-- OCR 経路の品番ごと解析キャッシュ（/api/order-from-ocr）
create table if not exists public.ocr_order_cache (
  product_code text primary key,
  result jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists ocr_order_cache_updated_at_idx
  on public.ocr_order_cache (updated_at desc);

comment on table public.ocr_order_cache is 'order-from-ocr: 品番ごとの検索・解析結果キャッシュ';


-- ================================ --

-- 1. メーカーマスタ
CREATE TABLE public.manufacturers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(50) NOT NULL,
  code_prefix VARCHAR(10)[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. カタログマスタ
CREATE TABLE public.catalogs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manufacturer_id UUID REFERENCES public.manufacturers(id) ON DELETE CASCADE,
  title VARCHAR(100) NOT NULL,
  valid_from DATE,
  valid_to DATE,
  source_pdf_path VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 壁紙（品番）データバンク（最重要テーブル）
CREATE TABLE public.wallpapers (
  code VARCHAR(50) PRIMARY KEY, -- 品番 (例: "SP9512") 正規化済み（ハイフンなし等）
  manufacturer_id UUID REFERENCES public.manufacturers(id) ON DELETE CASCADE,
  catalog_id UUID REFERENCES public.catalogs(id) ON DELETE CASCADE,
  spec VARCHAR(100), -- 規格 (例: "92cm x 50m")
  repeat_v VARCHAR(50), -- タテリピート
  repeat_h VARCHAR(50), -- ヨコリピート
  pattern_match VARCHAR(50), -- 柄合わせ (例: "エンボスリピート")
  notes TEXT, -- 防カビ、表面強化などの備考
  catalog_page_num INTEGER, -- カタログ上の掲載ページ
  pdf_segment_path VARCHAR(255), -- Supabase Storage内の1ページPDFまたは画像パス
  is_live_searched BOOLEAN DEFAULT FALSE, -- ライブ検索で自動追加されたか
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 検索用インデックス
CREATE INDEX wallpapers_updated_at_idx ON public.wallpapers (updated_at DESC);
CREATE INDEX wallpapers_manufacturer_id_idx ON public.wallpapers (manufacturer_id);

-- RLS設定 (フロントエンドからの読み取り専用許可設計)
ALTER TABLE public.manufacturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallpapers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access for manufacturers" ON public.manufacturers FOR SELECT USING (true);
CREATE POLICY "Allow public read access for catalogs" ON public.catalogs FOR SELECT USING (true);
CREATE POLICY "Allow public read access for wallpapers" ON public.wallpapers FOR SELECT USING (true);

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('catalog_pages', 'catalog_pages', true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'catalog_pages');


-- ================================ --

-- wallpapersテーブルにライブ検索元のURLと推論の確信度を保存するカラムを追加
ALTER TABLE public.wallpapers
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS confidence REAL;


-- ================================ --

-- 新しいテーブル: wallpaper_catalogs
CREATE TABLE public.wallpaper_catalogs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manufacturer_name VARCHAR(100) NOT NULL,
  catalog_name VARCHAR(150) NOT NULL,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- アクセス設定 (RLS)
ALTER TABLE public.wallpaper_catalogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access for wallpaper_catalogs" ON public.wallpaper_catalogs FOR SELECT USING (true);

-- Storage bucketの設定
INSERT INTO storage.buckets (id, name, public) VALUES ('wallpapers-catalogs', 'wallpapers-catalogs', true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Public Access for wallpapers-catalogs" ON storage.objects FOR SELECT USING (bucket_id = 'wallpapers-catalogs');
