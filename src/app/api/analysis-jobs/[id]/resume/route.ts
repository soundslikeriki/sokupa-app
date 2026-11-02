import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { authorize } from "@/lib/server-auth";
import { UUID_PATTERN } from "@/lib/memo-storage";
import { runAnalysisJob } from "@/lib/analysisJobProcessor";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(params.id)) return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  const { data, error } = await auth.admin.from("analysis_jobs").select("id").eq("id", params.id).eq("line_user_id", auth.lineUserId).maybeSingle();
  if (error) return NextResponse.json({ error: "再開を確認できませんでした" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  waitUntil(runAnalysisJob({ admin: auth.admin, jobId: params.id }));
  return NextResponse.json({ success: true }, { status: 202 });
}
