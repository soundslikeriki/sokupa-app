-- Asynchronous analysis jobs for background processing

-- Storage bucket for uploaded memo images (public read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('memo_uploads', 'memo_uploads', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read memo_uploads"
ON storage.objects
FOR SELECT
USING (bucket_id = 'memo_uploads');

-- Job master
CREATE TABLE IF NOT EXISTS public.analysis_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  site_name TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_images INTEGER NOT NULL DEFAULT 0,
  done_images INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS analysis_jobs_created_at_idx ON public.analysis_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx ON public.analysis_jobs (status);

ALTER TABLE public.analysis_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access for analysis_jobs"
ON public.analysis_jobs
FOR SELECT
USING (true);

-- Job items
CREATE TABLE IF NOT EXISTS public.analysis_job_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES public.analysis_jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  parsed JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, idx)
);

CREATE INDEX IF NOT EXISTS analysis_job_images_job_idx ON public.analysis_job_images (job_id, idx);

ALTER TABLE public.analysis_job_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access for analysis_job_images"
ON public.analysis_job_images
FOR SELECT
USING (true);

