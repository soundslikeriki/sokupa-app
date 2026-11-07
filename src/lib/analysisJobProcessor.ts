import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAnalysisCompletionMessages } from "@/lib/analysis-notification";

import type { ParsedMemoPayload } from "@/types";
import { mergeParsedPayloads } from "@/lib/memo-calculation";
import { parseMemoBody } from "@/lib/parseMemo";
import { MEMO_BUCKET, memoObjectPath, MAX_MEMO_BYTES } from "@/lib/memo-storage";
import { sendLineMessages } from "@/lib/line-notification";
import { isInfrastructureParseFailure, providerError, type ParseFailure } from "@/lib/analysis-failure";

export type AnalysisJobStepResult = {
  status: "running" | "done" | "failed";
  error?: string;
  /** A terminal content/job failure does not mean the worker infrastructure is unhealthy. */
  failureKind?: "job" | "infrastructure";
};

const infrastructureFailure = (error: string, status: AnalysisJobStepResult["status"] = "running"): AnalysisJobStepResult => ({ status, error, failureKind: "infrastructure" });
class NotificationStateError extends Error {}

async function notifyCompletion(admin: SupabaseClient, job: any, result: ParsedMemoPayload) {
  const started = Date.now();
  try {
    if (job.notification_protocol !== "line_retry_v1") {
      const { error } = await admin.from("analysis_jobs").update({ notification_status: "legacy_unknown" }).eq("id", job.id).in("notification_status", ["pending", "failed"]);
      if (error) throw new NotificationStateError("Notification quarantine recording failed");
      return;
    }
    // LINE retains retry keys for 24 hours. Never automatically resend outside that window.
    if (job.notification_attempted_at && started - Date.parse(job.notification_attempted_at) > 23 * 60 * 60 * 1000) {
      const { error } = await admin.from("analysis_jobs").update({ notification_status: "uncertain", notification_error: "Retry window expired; confirm delivery before resending", updated_at: new Date().toISOString() }).eq("id", job.id).neq("notification_status", "accepted");
      if (error) throw new NotificationStateError("Notification expiry recording failed");
      return;
    }
    if (!job.notification_attempted_at) {
      const { error } = await admin.from("analysis_jobs").update({ notification_attempted_at: new Date().toISOString() }).eq("id", job.id).is("notification_attempted_at", null);
      if (error) throw new NotificationStateError("notification attempt recording failed");
    }
    const messages = buildAnalysisCompletionMessages(result, job.site_name);
    await sendLineMessages(job.line_user_id, messages, job.id);
    const { error } = await admin.from("analysis_jobs").update({ notification_status: "accepted", notification_error: null, notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    if (error) throw new NotificationStateError("notification state update failed");
    console.info("[analysis-job] notification", { jobId: job.id, status: "accepted", durationMs: Date.now() - started });
  } catch (error) {
    if (error instanceof NotificationStateError) throw error;
    const message = error instanceof Error ? error.message : "notification failed";
    const { error: recordError } = await admin.from("analysis_jobs").update({ notification_status: "failed", notification_error: message, updated_at: new Date().toISOString() }).eq("id", job.id).neq("notification_status", "accepted");
    if (recordError) throw new NotificationStateError("Notification failure recording failed");
    console.error("[analysis-job] notification", { jobId: job.id, status: "failed", durationMs: Date.now() - started });
  }
}

/**
 * 1ステップだけ解析を進める（1枚 or finalize）。
 * Vercel の実行時間制限があるため、呼び出し側でループして複数回叩く想定。
 */
export async function processAnalysisJobStep(opts: {
  admin: SupabaseClient;
  jobId: string;
  /** Internal test seam; never supplied from HTTP input. */
  parse?: (body: Parameters<typeof parseMemoBody>[0]) => Promise<Response>;
  finalizeOnly?: boolean;
}): Promise<AnalysisJobStepResult> {
  const { admin, jobId } = opts;

  const { data: job, error: jobErr } = await admin
    .from("analysis_jobs")
    .select("id,status,execution_mode,site_name,line_user_id,context,total_images,done_images,notification_status,notification_protocol,notification_attempted_at,result,failure_kind,error")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) {
    console.error("[analysis-job] job fetch failed", { jobId, jobErr });
    return infrastructureFailure(jobErr?.message || "job not found", "failed");
  }
  if (job.execution_mode === "legacy") {
    return job.status === "done" ? { status: "done" } : { status: "failed", failureKind: "job", error: "旧版の未完了解析は保存しています。必要な画像を選んで新しく解析してください。" };
  }
  if (job.status === "done") {
    try {
      if (["pending", "failed"].includes(job.notification_status) && job.result) await notifyCompletion(admin, job, job.result as ParsedMemoPayload);
    } catch { return infrastructureFailure("Notification state unavailable", "done"); }
    return { status: "done" };
  }
  if (job.status === "failed") return job.failure_kind === "infrastructure" ? infrastructureFailure(job.error || "Infrastructure failure", "failed") : { status: "failed", failureKind: "job" };

  const { data: claims, error: imgErr } = opts.finalizeOnly
    ? { data: [], error: null }
    : await admin.rpc("claim_analysis_image", { p_job_id: jobId });
  if (imgErr) {
    console.error("[analysis-job] claim failed", { jobId, error: imgErr.message });
    return infrastructureFailure("Image claim failed");
  }
  const img = claims?.[0] as { id: string; idx: number; url: string; lease_token: string } | undefined;

  if (!img) {
    const { data: rows, error: rowsErr } = await admin
      .from("analysis_job_images")
      .select("idx,parsed,status")
      .eq("job_id", jobId)
      .order("idx", { ascending: true });
    if (rowsErr) {
      console.error("[analysis-job] finalize rows failed", { jobId, rowsErr });
      return infrastructureFailure(rowsErr.message, "failed");
    }
    // A claim can stop an exhausted lease and settle quota in its transaction.
    if ((rows ?? []).some(row => row.status === "failed")) {
      const {data: current,error: currentError}=await admin.from("analysis_jobs").select("status,error,failure_kind").eq("id",jobId).maybeSingle();
      if (currentError || !current) return infrastructureFailure("Job status lookup failed");
      if (current.status === "failed" && current.failure_kind === "infrastructure") return infrastructureFailure(current.error || "Infrastructure failure", "failed");
    }

    // Another worker may own a running image. Never finalize a partial result.
    if ((rows ?? []).some((row) => row.status === "running" || row.status === "queued")) {
      const { data: current, error: currentError } = await admin.from("analysis_jobs").select("status,error").eq("id", jobId).maybeSingle();
      if (currentError || !current) return infrastructureFailure("Job status lookup failed");
      if (current.status === "failed") return { status: "failed", error: current.error, failureKind: "job" };
      return { status: "running" };
    }
    if ((rows ?? []).length === 0 || (rows ?? []).length !== job.total_images || (rows ?? []).some((row) => row.status !== "done" || !Array.isArray(row.parsed?.items) || row.parsed.items.length === 0)) {
      const { error } = await admin.from("analysis_jobs").update({ status: "failed", error: "画像の解析結果が揃っていません。画像を確認してください。" }).eq("id", jobId);
      return error ? infrastructureFailure("Job failure recording failed") : { status: "failed", error: "Incomplete image results", failureKind: "job" };
    }
    const payloads = (rows ?? [])
      .filter((r: any) => r.status === "done" && r.parsed)
      .map((r: any) => r.parsed as ParsedMemoPayload);
    let resultPayload: ParsedMemoPayload;
    try { resultPayload = mergeParsedPayloads(payloads); }
    catch {
      const { error } = await admin.from("analysis_jobs").update({ status: "failed", error: "保存された解析結果が不正です。画像を確認してください。" }).eq("id", jobId);
      return error ? infrastructureFailure("Job failure recording failed") : { status: "failed", error: "Invalid parsed result", failureKind: "job" };
    }

    const { data: finalized, error: finErr } = await admin
      .from("analysis_jobs")
      .update({
        status: "done",
        done_images: job.total_images ?? 0,
        result: resultPayload,
        notification_status: "pending",
        notification_protocol: "line_retry_v1",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId).in("status", ["queued", "running"]).select("id").maybeSingle();
    if (finErr) {
      console.error("[analysis-job] finalize job update failed", { jobId, finErr });
      return infrastructureFailure(finErr.message, "failed");
    }
    if (!finalized) return { status: "done" };

    try { await notifyCompletion(admin, { ...job, notification_protocol: "line_retry_v1" }, resultPayload); }
    catch { return infrastructureFailure("Notification state unavailable", "done"); }
    return { status: "done" };
  }

  const recordProviderFailure = async (failure: ParseFailure): Promise<AnalysisJobStepResult> => {
    const {data,error}=await admin.rpc("defer_analysis_image",{p_image_id:img.id,p_lease_token:img.lease_token,p_code:failure.code,p_retryable:failure.retryable,p_retry_after_seconds:failure.retry_after_seconds??0,p_delivery_unknown:failure.delivery_unknown});
    if (error || !["queued","failed","stale"].includes(data)) return infrastructureFailure("Provider failure recording failed");
    return infrastructureFailure(data === "queued" ? "解析サービスが一時的に利用できません。待ち時間を置いて再試行します。" : "解析サービスの障害により処理を停止しました。",data === "failed" ? "failed" : "running");
  };
  try {
    const context = job.context && typeof job.context === "object" ? job.context : {};
    const started = Date.now();
    const objectPath = memoObjectPath(img.url, process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const { data: image, error: downloadError } = await admin.storage.from(MEMO_BUCKET).download(objectPath);
    if (downloadError && ![400,404].includes(Number("statusCode" in downloadError ? downloadError.statusCode : undefined))) return infrastructureFailure("Image storage unavailable");
    if (downloadError || !image || !image.size || image.size > MAX_MEMO_BYTES) throw new Error("画像を読み込めませんでした。画像を選び直してください。");
    const parseRes = await (opts.parse ?? parseMemoBody)({
      base64Image: Buffer.from(await image.arrayBuffer()).toString("base64"), mimeType: image.type || "image/jpeg", context,
    });
    console.info("[analysis-job] image timing", { jobId, imageId: img.id, durationMs: Date.now() - started, status: parseRes.status });
    let parseJson: any;
    try { parseJson = await parseRes.json(); }
    catch { return recordProviderFailure(providerError({status:502}).failure); }
    if (isInfrastructureParseFailure(parseJson?.failure)) return recordProviderFailure(parseJson.failure);
    if (parseRes.status === 429 || parseRes.status >= 500) return recordProviderFailure(providerError({status:parseRes.status}).failure);
    if (!parseRes.ok || parseJson?.error || !parseJson?.data?.items?.length) {
      throw new Error(parseJson?.error || `parse-memo failed: ${parseRes.status}`);
    }

    const { data: completed, error: completeError } = await admin.rpc("complete_analysis_image", {
      p_image_id: img.id, p_lease_token: img.lease_token, p_parsed: parseJson.data,
    });
    if (completeError) return infrastructureFailure("解析結果の保存を確認できませんでした。再開時に状態を確認します。");
    // An expired worker never overwrites the result of a new lease holder.
    if (!completed) return { status: "running" };
    return processAnalysisJobStep({ ...opts, finalizeOnly: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[analysis-job] image failed", { jobId, imageId: img.id, msg });
    const { data: failed, error: failError } = await admin.rpc("fail_analysis_image", { p_image_id: img.id, p_lease_token: img.lease_token, p_error: msg });
    if (failError) return infrastructureFailure("Image failure recording failed");
    return failed ? { status: "failed", error: msg, failureKind: "job" } : { status: "running" };
  }
}

/** Start another image only while most of the 300s invocation budget remains. */
export async function runAnalysisJob(opts: Parameters<typeof processAnalysisJobStep>[0]) {
  const started = Date.now();
  for (let step = 0; step < 6; step++) {
    const result = await processAnalysisJobStep(opts);
    if (result.status !== "running" || result.error || Date.now() - started >= 30_000) return result;
  }
  return { status: "running" as const };
}
