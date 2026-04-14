import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { processAnalysisJobStep } from "@/lib/analysisJobProcessor";

export const runtime = "nodejs";
export const maxDuration = 300;

type CreateJobBody = {
  image_urls?: string[];
  site_name?: string;
  context?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateJobBody;
    const urls = Array.isArray(body.image_urls)
      ? body.image_urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (urls.length === 0) {
      return NextResponse.json({ error: "image_urls is required" }, { status: 400 });
    }
    if (urls.length > 16) {
      return NextResponse.json({ error: "images must be <= 16" }, { status: 400 });
    }

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

    const site_name = typeof body.site_name === "string" ? body.site_name.trim() : null;
    const context = body.context && typeof body.context === "object" ? body.context : {};

    const { data: job, error: jobErr } = await admin
      .from("analysis_jobs")
      .insert({
        status: "queued",
        site_name,
        context,
        total_images: urls.length,
        done_images: 0,
      })
      .select("id")
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: jobErr?.message || "job insert failed" }, { status: 500 });
    }

    const rows = urls.map((url, idx) => ({
      job_id: job.id,
      idx,
      url,
      status: "queued",
    }));
    const { error: imgErr } = await admin.from("analysis_job_images").insert(rows);
    if (imgErr) {
      return NextResponse.json({ error: imgErr.message }, { status: 500 });
    }

    console.log("[analysis-job] created", { job_id: job.id, images: urls.length });

    // Kick off processing synchronously in this request (works even if ANALYSIS_JOB_SECRET is unset).
    // Vercel maxDuration caps total runtime; each step is bounded by parse-memo + DB updates.
    const maxSteps = urls.length + 3;
    for (let i = 0; i < maxSteps; i++) {
      const step = await processAnalysisJobStep({ admin, jobId: job.id, headers: req.headers });
      console.log("[analysis-job] step", { job_id: job.id, i, status: step.status });
      if (step.status === "done" || step.status === "failed") break;
    }

    return NextResponse.json({ success: true, job_id: job.id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

