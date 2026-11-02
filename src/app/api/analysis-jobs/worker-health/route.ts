import { NextRequest, NextResponse } from "next/server";
import { requireScheduledSecret } from "@/lib/jobSecret";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { analysisBackgroundReady } from "@/lib/analysis-background";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!requireScheduledSecret(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createSupabaseAdmin();
  const ready = Boolean(admin && await analysisBackgroundReady(admin));
  return NextResponse.json({ processing_ready: ready }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
