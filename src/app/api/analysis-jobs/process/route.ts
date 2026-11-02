import { analysisDataAccessSecure } from "@/lib/analysis-background";
import { runScheduledAnalysisBatch } from "@/lib/analysis-scheduled";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { processAnalysisJobStep } from "@/lib/analysisJobProcessor";
import { requireJobSecret, requireScheduledSecret } from "@/lib/jobSecret";
import {verifySchedulerDispatch} from "@/lib/scheduler-dispatch";

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

    if (!(await analysisDataAccessSecure(admin))) return NextResponse.json({ error: "Private data access not secured" }, { status: 503 });
    const step = await processAnalysisJobStep({ admin, jobId: job_id });
    if (step.failureKind === "infrastructure") return NextResponse.json({ success: false, status: step.status, error: step.error }, { status: 503 });
    if (step.status === "failed") {
      return NextResponse.json({ success: false, status: "failed", error: step.error || "failed" }, { status: 500 });
    }
    return NextResponse.json({ success: true, status: step.status });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Private scheduled recovery. Configure its scheduler only after release approval. */
export async function GET(req: NextRequest) {
  const existingSecret=requireScheduledSecret(req);
  const dispatch=existingSecret?null:verifySchedulerDispatch(req);
  if (!existingSecret&&!dispatch) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Server not configured" }, { status: 503 });
  try {
    if(dispatch){
      const {data,error}=await admin.rpc("claim_analysis_dispatch",{p_id:dispatch.id,p_issued_at:dispatch.issuedAt,p_expires_at:dispatch.expiresAt});
      if(error)return NextResponse.json({error:"Dispatch verification unavailable"},{status:503});
      if(data!==true)return NextResponse.json({error:"Expired or duplicate dispatch"},{status:409});
    }
    const result = await runScheduledAnalysisBatch(admin,undefined,dispatch?.id);
    return NextResponse.json({...result,...(dispatch?{dispatch_id:dispatch.id}:{})});
  } catch {
    console.error("[analysis-worker] scheduled batch failed");
    return NextResponse.json({ error: "Scheduled processing failed" }, { status: 503 });
  }
}
