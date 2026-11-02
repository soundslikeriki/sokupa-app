import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOrderRequestText } from "@/lib/order-text";

import type { ParsedMemoPayload } from "@/types";
import { mergeParsedPayloads, requiresMemoReview } from "@/lib/memo-calculation";
import { parseMemoBody } from "@/lib/parseMemo";
import { MEMO_BUCKET, memoObjectPath, MAX_MEMO_BYTES } from "@/lib/memo-storage";
import { sendLineMessages } from "@/lib/line-notification";

async function notifyCompletion(admin: SupabaseClient, job: any, result: ParsedMemoPayload) {
  const started = Date.now();
  try {
    if (job.notification_protocol !== "line_retry_v1") {
      await admin.from("analysis_jobs").update({ notification_status: "legacy_unknown" }).eq("id", job.id).in("notification_status", ["pending", "failed"]);
      return;
    }
    // LINE retains retry keys for 24 hours. Never automatically resend outside that window.
    if (job.notification_attempted_at && started - Date.parse(job.notification_attempted_at) > 23 * 60 * 60 * 1000) {
      await admin.from("analysis_jobs").update({ notification_status: "uncertain", notification_error: "Retry window expired; confirm delivery before resending", updated_at: new Date().toISOString() }).eq("id", job.id).neq("notification_status", "accepted");
      return;
    }
    if (!job.notification_attempted_at) {
      const { error } = await admin.from("analysis_jobs").update({ notification_attempted_at: new Date().toISOString() }).eq("id", job.id).is("notification_attempted_at", null);
      if (error) throw new Error("notification attempt recording failed");
    }
    const messages = [{ type: "text", text: `✅ ソクパ解析が完了しました！${job.site_name ? `\n現場：${job.site_name}` : ""}\nアプリを開いて結果を確認してください。` }];
    // Uncertain calculations must be reviewed in the app before presenting an order text.
    if (!requiresMemoReview(result)) {
      const orderText = buildOrderRequestText(result.items, job.site_name);
      if (orderText.length <= 4900) messages.push({ type: "text", text: orderText });
    }
    await sendLineMessages(job.line_user_id, messages, job.id);
    const { error } = await admin.from("analysis_jobs").update({ notification_status: "accepted", notification_error: null, notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    if (error) throw new Error("notification state update failed");
    console.info("[analysis-job] notification", { jobId: job.id, status: "accepted", durationMs: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : "notification failed";
    await admin.from("analysis_jobs").update({ notification_status: "failed", notification_error: message, updated_at: new Date().toISOString() }).eq("id", job.id).neq("notification_status", "accepted");
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
}): Promise<{ status: "running" | "done" | "failed"; error?: string }> {
  const { admin, jobId } = opts;

  const { data: job, error: jobErr } = await admin
    .from("analysis_jobs")
    .select("id,status,site_name,line_user_id,context,total_images,done_images,notification_status,notification_protocol,notification_attempted_at,result")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) {
    console.error("[analysis-job] job fetch failed", { jobId, jobErr });
    return { status: "failed", error: jobErr?.message || "job not found" };
  }
  if (job.status === "done") {
    if (["pending", "failed"].includes(job.notification_status) && job.result) await notifyCompletion(admin, job, job.result as ParsedMemoPayload);
    return { status: "done" };
  }
  if (job.status === "failed") return { status: "failed" };

  const { data: claims, error: imgErr } = opts.finalizeOnly
    ? { data: [], error: null }
    : await admin.rpc("claim_analysis_image", { p_job_id: jobId });
  if (imgErr) {
    console.error("[analysis-job] claim failed", { jobId, error: imgErr.message });
    return { status: "running", error: "Image claim failed" };
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
      return { status: "failed", error: rowsErr.message };
    }

    // Another worker may own a running image. Never finalize a partial result.
    if ((rows ?? []).some((row) => row.status === "running" || row.status === "queued")) {
      const { data: current } = await admin.from("analysis_jobs").select("status,error").eq("id", jobId).maybeSingle();
      if (current?.status === "failed") return { status: "failed", error: current.error };
      return { status: "running" };
    }
    if ((rows ?? []).length === 0 || (rows ?? []).length !== job.total_images || (rows ?? []).some((row) => row.status !== "done" || !Array.isArray(row.parsed?.items) || row.parsed.items.length === 0)) {
      await admin.from("analysis_jobs").update({ status: "failed", error: "画像の解析結果が揃っていません。画像を確認してください。" }).eq("id", jobId);
      return { status: "failed", error: "Incomplete image results" };
    }
    const payloads = (rows ?? [])
      .filter((r: any) => r.status === "done" && r.parsed)
      .map((r: any) => r.parsed as ParsedMemoPayload);
    let resultPayload: ParsedMemoPayload;
    try { resultPayload = mergeParsedPayloads(payloads); }
    catch {
      await admin.from("analysis_jobs").update({ status: "failed", error: "保存された解析結果が不正です。画像を確認してください。" }).eq("id", jobId);
      return { status: "failed", error: "Invalid parsed result" };
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
      return { status: "failed", error: finErr.message };
    }
    if (!finalized) return { status: "done" };

    await notifyCompletion(admin, { ...job, notification_protocol: "line_retry_v1" }, resultPayload);
    return { status: "done" };
  }

  try {
    const context = job.context && typeof job.context === "object" ? job.context : {};
    const started = Date.now();
    const objectPath = memoObjectPath(img.url, process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const { data: image, error: downloadError } = await admin.storage.from(MEMO_BUCKET).download(objectPath);
    if (downloadError || !image || !image.size || image.size > MAX_MEMO_BYTES) throw new Error("画像を読み込めませんでした。画像を選び直してください。");
    const parseRes = await (opts.parse ?? parseMemoBody)({
      base64Image: Buffer.from(await image.arrayBuffer()).toString("base64"), mimeType: image.type || "image/jpeg", context,
    });
    console.info("[analysis-job] image timing", { jobId, imageId: img.id, durationMs: Date.now() - started, status: parseRes.status });
    const parseJson = (await parseRes.json()) as any;
    if (!parseRes.ok || parseJson?.error || !parseJson?.data?.items?.length) {
      throw new Error(parseJson?.error || `parse-memo failed: ${parseRes.status}`);
    }

    const { data: completed, error: completeError } = await admin.rpc("complete_analysis_image", {
      p_image_id: img.id, p_lease_token: img.lease_token, p_parsed: parseJson.data,
    });
    if (completeError) return { status: "running", error: "解析結果の保存を確認できませんでした。再開時に状態を確認します。" };
    // An expired worker never overwrites the result of a new lease holder.
    if (!completed) return { status: "running" };
    return processAnalysisJobStep({ ...opts, finalizeOnly: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[analysis-job] image failed", { jobId, imageId: img.id, msg });
    const { data: failed } = await admin.rpc("fail_analysis_image", { p_image_id: img.id, p_lease_token: img.lease_token, p_error: msg });
    return failed ? { status: "failed", error: msg } : { status: "running" };
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
