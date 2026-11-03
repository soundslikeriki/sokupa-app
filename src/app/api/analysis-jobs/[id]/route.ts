import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { UUID_PATTERN } from "@/lib/memo-storage";
import { analysisBackgroundReady } from "@/lib/analysis-background";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(params.id)) return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  const { data, error } = await auth.admin.from("analysis_jobs")
    .select("id,status,site_name,done_images,total_images,result,error,failure_kind,quota_reserved,quota_refunded,quota_tracking,notification_status,execution_mode,analysis_job_images(status,lease_expires_at,updated_at,recovery_not_before)")
    .eq("id", params.id).eq("line_user_id", auth.lineUserId).maybeSingle();
  if (error) return NextResponse.json({ error: "結果の取得に失敗しました" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const images = data.analysis_job_images ?? [];
  const active = images.some((image) => (["queued", "running"].includes(image.status) && Date.parse(image.recovery_not_before) > Date.now()) || (image.status === "running" && Date.parse(image.lease_expires_at || image.updated_at) + (image.lease_expires_at ? 0 : 360_000) > Date.now()));
  const can_resume = (["queued", "running"].includes(data.status) && !active) || (data.status === "done" && ["pending", "failed"].includes(data.notification_status));
  const background_ready = ["scheduled", "scheduled-wake"].includes(data.execution_mode) && data.execution_mode === process.env.ANALYSIS_BACKGROUND_MODE && await analysisBackgroundReady(auth.admin);
  return NextResponse.json({ data: { ...data, analysis_job_images: undefined, can_resume, background_ready } }, { headers: { "Cache-Control": "no-store" } });
}
