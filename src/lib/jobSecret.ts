export function requireJobSecret(req: Request): boolean {
  const expected = process.env.ANALYSIS_JOB_SECRET?.trim();
  if (!expected) return false;
  const got = req.headers.get("x-job-secret")?.trim();
  return Boolean(got && got === expected);
}

