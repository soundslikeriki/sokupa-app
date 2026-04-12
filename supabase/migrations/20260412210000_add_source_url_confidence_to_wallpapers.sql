-- wallpapersテーブルにライブ検索元のURLと推論の確信度を保存するカラムを追加
ALTER TABLE public.wallpapers
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS confidence REAL;
