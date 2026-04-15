import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const lineUserId = req.nextUrl.searchParams.get("line_user_id") || "";
    if (!lineUserId) return NextResponse.json({ unlimited: false });

    const admin = createSupabaseAdmin();
    if (!admin) return NextResponse.json({ unlimited: false });

    const { data } = await admin
      .from("unlimited_users")
      .select("id")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    return NextResponse.json({ unlimited: !!data });
  } catch {
    return NextResponse.json({ unlimited: false });
  }
}

