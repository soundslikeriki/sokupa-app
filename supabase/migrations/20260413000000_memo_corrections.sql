-- Human-in-the-loop corrections log for parsed memo results

CREATE TABLE IF NOT EXISTS public.memo_corrections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  site_name TEXT,
  kind TEXT NOT NULL,
  before JSONB NOT NULL DEFAULT '{}'::jsonb,
  after JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS memo_corrections_created_at_idx ON public.memo_corrections (created_at DESC);
CREATE INDEX IF NOT EXISTS memo_corrections_kind_idx ON public.memo_corrections (kind);

ALTER TABLE public.memo_corrections ENABLE ROW LEVEL SECURITY;

-- Read-only for public. Inserts are intended via service role from API.
CREATE POLICY "Allow public read access for memo_corrections"
ON public.memo_corrections
FOR SELECT
USING (true);

