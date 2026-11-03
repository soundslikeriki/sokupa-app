import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { UUID_PATTERN } from "@/lib/memo-storage";
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(params.id)) return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  const { data, error } = await auth.admin.from("analysis_jobs").update({ client_result_seen_at: new Date().toISOString() })
    .eq("id", params.id).eq("line_user_id", auth.lineUserId).in("status", ["done", "failed"]).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "結果の確認を保存できませんでした" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
