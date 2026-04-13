import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { requireJobSecret } from "@/lib/jobSecret";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { job_id?: string };

function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

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

    const { data: job, error: jobErr } = await admin
      .from("analysis_jobs")
      .select("id,status,site_name,context,total_images,done_images")
      .eq("id", job_id)
      .maybeSingle();
    if (jobErr || !job) return NextResponse.json({ error: jobErr?.message || "job not found" }, { status: 404 });
    if (job.status === "done" || job.status === "failed") {
      return NextResponse.json({ success: true, status: job.status });
    }

    // pick next queued
    const { data: img, error: imgErr } = await admin
      .from("analysis_job_images")
      .select("id,idx,url,status")
      .eq("job_id", job_id)
      .in("status", ["queued", "running"])
      .order("idx", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (imgErr) return NextResponse.json({ error: imgErr.message }, { status: 500 });
    if (!img) {
      // finalize
      await admin.from("analysis_jobs").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", job_id);

      const base = getBaseUrl(req);
      // Build a minimal completion message (order list text is generated client-side too; keep this short)
      const siteName = typeof job.site_name === "string" && job.site_name.trim() ? job.site_name.trim() : "";
      fetch(`${base}/api/send-line`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `ソクパ解析が完了しました。${siteName ? `\n現場: ${siteName}` : ""}\n（アプリに戻って結果を確認してください）`,
        }),
      }).catch(() => {});

      return NextResponse.json({ success: true, status: "done" });
    }

    // mark running
    await admin.from("analysis_jobs").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", job_id);
    await admin
      .from("analysis_job_images")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", img.id);

    try {
      const base64 = await fetchAsBase64(img.url);
      const base = getBaseUrl(req);
      const context = job.context && typeof job.context === "object" ? job.context : {};
      const parseRes = await fetch(`${base}/api/parse-memo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Image: base64,
          mimeType: "image/jpeg",
          context,
        }),
      });
      const parseJson = (await parseRes.json()) as any;
      if (!parseRes.ok || parseJson?.error) {
        throw new Error(parseJson?.error || `parse-memo failed: ${parseRes.status}`);
      }

      await admin
        .from("analysis_job_images")
        .update({
          status: "done",
          parsed: parseJson?.data ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", img.id);
      await admin
        .from("analysis_jobs")
        .update({
          done_images: Math.min(job.total_images ?? 0, (job.done_images ?? 0) + 1),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "failed";
      await admin
        .from("analysis_job_images")
        .update({ status: "failed", error: msg, updated_at: new Date().toISOString() })
        .eq("id", img.id);
      await admin.from("analysis_jobs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", job_id);
      return NextResponse.json({ success: false, status: "failed", error: msg }, { status: 500 });
    }

    // chain next (fire-and-forget)
    const secret = process.env.ANALYSIS_JOB_SECRET?.trim();
    if (secret) {
      const base = getBaseUrl(req);
      fetch(`${base}/api/analysis-jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-job-secret": secret },
        body: JSON.stringify({ job_id }),
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, status: "running" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

