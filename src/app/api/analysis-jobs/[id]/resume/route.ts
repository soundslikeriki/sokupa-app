import { analysisBackgroundReady } from "@/lib/analysis-background";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { authorize } from "@/lib/server-auth";
import { UUID_PATTERN } from "@/lib/memo-storage";
import { runAnalysisJob } from "@/lib/analysisJobProcessor";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  const { data, error } = await auth.admin.from("analysis_jobs").select("id,execution_mode").eq("id", id).eq("line_user_id", auth.lineUserId).maybeSingle();
  if (error) return NextResponse.json({ error: "再開を確認できませんでした" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (data.execution_mode === "legacy") return NextResponse.json({ error: "旧版の解析は自動で再実行しません。必要な画像を選んで新しく解析してください。" }, { status: 409 });
  if (!(await analysisBackgroundReady(auth.admin))) return NextResponse.json({ error: "解析サービスの準備ができていません。時間をおいて再度お試しください。" }, { status: 503 });
  waitUntil(runAnalysisJob({ admin: auth.admin, jobId: id }));
  return NextResponse.json({ success: true }, { status: 202 });
}
