import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { UUID_PATTERN } from "@/lib/memo-storage";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!UUID_PATTERN.test(params.id)) return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  const { data, error } = await auth.admin.from("analysis_jobs")
    .select("id,status,site_name,done_images,total_images,result,error,notification_status")
    .eq("id", params.id).eq("line_user_id", auth.lineUserId).maybeSingle();
  if (error) return NextResponse.json({ error: "結果の取得に失敗しました" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
}
