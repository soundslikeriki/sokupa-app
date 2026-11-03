export type NotificationWatch = { jobId: string; siteName: string | null; status: string; error?: string | null };

export function notificationRetryable(status: string): boolean {
  return status === "pending" || status === "failed";
}

export function analysisBlocksIntake(job: { status?: string } | null): boolean {
  return Boolean(job && !["done", "failed"].includes(job.status ?? ""));
}

export function needsAnalysisRestoration(job: { status: string; client_result_seen_at?: string | null }, hasSavedMemo: boolean, fromPointer = false): boolean {
  return ["queued", "running"].includes(job.status) || job.client_result_seen_at == null || (fromPointer && !hasSavedMemo);
}

export function mergeNotificationWatch(current: NotificationWatch[], incoming: NotificationWatch): NotificationWatch[] {
  const existing = current.find((watch) => watch.jobId === incoming.jobId);
  // Accepted/uncertain states cannot be downgraded by an older discovery response.
  const next = existing && !notificationRetryable(existing.status) && notificationRetryable(incoming.status) ? existing : incoming;
  const merged = existing ? current.map((watch) => watch.jobId === incoming.jobId ? next : watch) : [...current, next];
  const terminal = merged.filter((watch) => !notificationRetryable(watch.status)).slice(-10);
  return merged.filter((watch) => notificationRetryable(watch.status) || terminal.includes(watch));
}

export function forgetJobPointerIfMatches(storage: Pick<Storage, "getItem" | "removeItem">, lineUserId: string, jobId: string): void {
  for (const key of [`sokupa:lastJobId:${lineUserId}`, "sokupa:lastJobId"]) {
    if (storage.getItem(key) === jobId) storage.removeItem(key);
  }
}
