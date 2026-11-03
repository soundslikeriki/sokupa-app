import { analysisBackgroundReady } from "@/lib/analysis-background";
import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { ownedMemoPath } from "@/lib/memo-storage";
import { runAnalysisJob } from "@/lib/analysisJobProcessor";
import { waitUntil } from "@vercel/functions";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(req: NextRequest) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { data, error } = await auth.admin.from("analysis_jobs").select("id,status,client_result_seen_at,site_name,notification_status")
    .eq("line_user_id", auth.lineUserId)
    .or("status.in.(queued,running),client_result_seen_at.is.null,and(status.eq.done,notification_status.in.(pending,failed))")
    .order("client_result_seen_at", { ascending: true, nullsFirst: true }).order("updated_at", { ascending: false }).limit(10);
  if (error) return NextResponse.json({ error: "前回の解析を確認できませんでした" }, { status: 503 });
  return NextResponse.json({ data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: NextRequest) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const body = await req.json();
    const paths = body.image_paths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 5 || paths.some((path) => !ownedMemoPath(path, auth.lineUserId))) {
      return NextResponse.json({ error: "自分の画像を1〜5枚指定してください" }, { status: 400 });
    }
    if (!(await analysisBackgroundReady(auth.admin))) return NextResponse.json({ error: "解析サービスの準備ができていません。時間をおいて再度お試しください。" }, { status: 503 });
    const site = typeof body.site_name === "string" ? body.site_name.trim().slice(0, 200) : null;
    // Quota reservation + job/images creation is one transaction, including simultaneous requests.
    const { data: jobId, error } = await auth.admin.rpc("create_analysis_job", {
      p_line_user_id: auth.lineUserId, p_paths: paths, p_site_name: site, p_owner: auth.owner,
    });
    if (error || !jobId) {
      const limited = error?.message.includes("monthly_limit");
      return NextResponse.json({ error: limited ? "今月の利用上限（20枚）に達しました。" : "解析の受付に失敗しました。再度お試しください。" }, { status: limited ? 429 : 503 });
    }
    // Each image has an exclusive lease; longer jobs resume in separate invocations.
    waitUntil(runAnalysisJob({ admin: auth.admin, jobId }));
    return NextResponse.json({ success: true, job_id: jobId, execution_mode: process.env.ANALYSIS_BACKGROUND_MODE, background_ready: true });
  } catch {
    return NextResponse.json({ error: "解析の受付に失敗しました" }, { status: 500 });
  }
}
