import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: NextRequest) {
  const res = NextResponse.redirect(new URL("/?logout=1", _req.url), { status: 302 });

  res.cookies.delete("sokupa_invited");
  res.cookies.delete("sokupa_line_user_id");
  res.cookies.delete("sokupa_display_name");
  res.cookies.delete("sokupa_line_state");
  res.cookies.delete("sokupa_invite_code");

  return res;
}

