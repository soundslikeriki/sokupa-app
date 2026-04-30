import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const allCookies = req.cookies.getAll();
  const adminEnv = process.env.ADMIN_LINE_USER_ID ?? "(未設定)";
  return NextResponse.json({
    cookies: allCookies,
    adminEnv: adminEnv.slice(0, 5) + "...", // 先頭5文字だけ表示
  });
}

