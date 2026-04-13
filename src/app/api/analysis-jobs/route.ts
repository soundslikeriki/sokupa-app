import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

type CreateJobBody = {
  image_urls?: string[];
  site_name?: string;
  context?: Record<string, unknown>;
};

function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

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

    const secret = process.env.ANALYSIS_JOB_SECRET?.trim();
    if (secret) {
      const base = getBaseUrl(req);
      // fire-and-forget kickoff
      fetch(`${base}/api/analysis-jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-job-secret": secret },
        body: JSON.stringify({ job_id: job.id }),
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, job_id: job.id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

