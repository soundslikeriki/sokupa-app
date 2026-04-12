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
