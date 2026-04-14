-- Allow anonymous uploads to memo_uploads (public app uploads memo images)
-- NOTE: This is intentionally permissive for MVP field UX. Tighten later with auth + signed URLs.

CREATE POLICY "Public insert memo_uploads"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (bucket_id = 'memo_uploads');

CREATE POLICY "Public update memo_uploads"
ON storage.objects
FOR UPDATE
TO public
USING (bucket_id = 'memo_uploads')
WITH CHECK (bucket_id = 'memo_uploads');
