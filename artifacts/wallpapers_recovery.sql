DROP TABLE IF EXISTS public.wallpapers CASCADE;

CREATE TABLE public.wallpapers (
  code VARCHAR(50) PRIMARY KEY,
  manufacturer_id UUID REFERENCES public.manufacturers(id) ON DELETE CASCADE,
  catalog_id UUID REFERENCES public.catalogs(id) ON DELETE CASCADE,
  spec VARCHAR(100),
  repeat_v VARCHAR(50),
  repeat_h VARCHAR(50),
  pattern_match VARCHAR(50),
  notes TEXT,
  catalog_page_num INTEGER,
  pdf_segment_path VARCHAR(255),
  is_live_searched BOOLEAN DEFAULT FALSE,
  source_url TEXT,
  confidence REAL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallpapers_updated_at_idx ON public.wallpapers (updated_at DESC);
CREATE INDEX IF NOT EXISTS wallpapers_manufacturer_id_idx ON public.wallpapers (manufacturer_id);

ALTER TABLE public.wallpapers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access for wallpapers" ON public.wallpapers FOR SELECT USING (true);

NOTIFY pgrst, 'reload schema';
