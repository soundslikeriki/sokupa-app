import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { INVITE_COOKIE, SESSION_COOKIE, verifyToken } from "@/lib/session-token";
import { qaSummary, readQaRuntime } from "@/lib/qa-runtime";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  let qa;
  try { qa = readQaRuntime(); } catch { return NextResponse.json({ error: "検証環境は停止中です", qa: { synthetic: true } }, {status:503,headers}); }
  if (!verifyToken(req.cookies.get(SESSION_COOKIE)?.value, "session")) {
    return NextResponse.json({ authenticated: false, invited: Boolean(qa || verifyToken(req.cookies.get(INVITE_COOKIE)?.value, "invite")), qa: qaSummary(qa) }, { headers });
  }
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  return NextResponse.json({ authenticated: true, line_user_id: auth.lineUserId, display_name: auth.user.display_name, admin: auth.owner, qa: qaSummary(qa), keep_open_for_progress: process.env.ANALYSIS_BACKGROUND_MODE === "interactive" }, { headers });
}
