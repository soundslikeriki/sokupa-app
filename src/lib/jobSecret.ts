import { timingSafeEqual } from "node:crypto";
export function requireJobSecret(req: Request): boolean {
  const expected = process.env.ANALYSIS_JOB_SECRET?.trim();
  const got = req.headers.get("x-job-secret")?.trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireScheduledSecret(req: Request): boolean {
  if (requireJobSecret(req)) return true;
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
