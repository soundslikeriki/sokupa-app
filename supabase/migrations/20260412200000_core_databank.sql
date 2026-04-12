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
