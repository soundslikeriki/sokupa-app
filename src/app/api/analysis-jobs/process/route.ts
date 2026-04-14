import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { processAnalysisJobStep } from "@/lib/analysisJobProcessor";
import { requireJobSecret } from "@/lib/jobSecret";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = { job_id?: string };

export async function POST(req: NextRequest) {
  try {
    if (!requireJobSecret(req)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json()) as Body;
    const job_id = typeof body.job_id === "string" ? body.job_id.trim() : "";
    if (!job_id) return NextResponse.json({ error: "job_id is required" }, { status: 400 });

    const admin = createSupabaseAdmin();
    if (!admin) return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });

    const step = await processAnalysisJobStep({ admin, jobId: job_id, headers: req.headers });
    if (step.status === "failed") {
      return NextResponse.json({ success: false, status: "failed", error: step.error || "failed" }, { status: 500 });
    }
    return NextResponse.json({ success: true, status: step.status });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
