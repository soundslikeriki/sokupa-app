import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { claimAnalysisWake, runAnalysisWake, wakeEnabled } from "@/lib/analysis-wake";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Public empty wake-up signal. A private, root-issued DB permit is the authority to do work. */
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    if (wakeEnabled() && url.pathname === "/api/analysis-jobs/wake" && !url.search && !url.hash) {
      const admin = createSupabaseAdmin();
      if (admin) {
        const claim = await claimAnalysisWake(admin, url.origin);
        if (claim) waitUntil(runAnalysisWake(admin, claim));
      }
    }
  } catch { console.error("[analysis-wake] signal unavailable"); }
  // No IDs, health result or other distinguishing data. A 204 cannot prove healthy processing.
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
