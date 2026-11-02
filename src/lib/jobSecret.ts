import { timingSafeEqual } from "node:crypto";
export function requireJobSecret(req: Request): boolean {
  const expected = process.env.ANALYSIS_JOB_SECRET?.trim();
  const got = req.headers.get("x-job-secret")?.trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
