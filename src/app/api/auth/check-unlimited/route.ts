import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { data, error } = await auth.admin.from("unlimited_users").select("id").eq("line_user_id", auth.lineUserId).maybeSingle();
  if (error) return NextResponse.json({ error: "確認に失敗しました" }, { status: 503 });
  return NextResponse.json({ unlimited: auth.owner || Boolean(data) }, { headers: { "Cache-Control": "no-store" } });
}
