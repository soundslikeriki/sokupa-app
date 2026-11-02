import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { sendLineMessages } from "@/lib/line-notification";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { text } = await req.json();
  if (typeof text !== "string" || !text.trim() || text.length > 4500) return NextResponse.json({ error: "Invalid text" }, { status: 400 });
  try {
    await sendLineMessages(auth.lineUserId, [{ type: "text", text: text.trim() }]);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "LINE通知に失敗しました" }, { status: 502 });
  }
}
