import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { processAnalysisJobStep } from "@/lib/analysisJobProcessor";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";
export const maxDuration = 300;

type CreateJobBody = {
  image_urls?: string[];
  site_name?: string;
  line_user_id?: string;
  context?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateJobBody;
    const line_user_id =
      (body as any)?.line_user_id || req.cookies.get("sokupa_line_user_id")?.value || "";
    const urls = Array.isArray(body.image_urls)
      ? body.image_urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (urls.length === 0) {
      return NextResponse.json({ error: "image_urls is required" }, { status: 400 });
    }
    if (urls.length > 5) {
      return NextResponse.json({ error: "images must be <= 5" }, { status: 400 });
    }

    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

    const site_name = typeof body.site_name === "string" ? body.site_name.trim() : null;
    const context = body.context && typeof body.context === "object" ? body.context : {};

    // LINEログイン必須
    const lineUserId = typeof line_user_id === "string" ? line_user_id.trim() : "";
    if (!lineUserId) {
      return NextResponse.json({ error: "LINEログインが必要です" }, { status: 401 });
    }

    // 無制限ユーザーチェック
    const { data: unlimitedUser } = await admin
      .from("unlimited_users")
      .select("id")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (!unlimitedUser) {
      // 今月の使用回数チェック
      const yearMonth = new Date().toISOString().slice(0, 7); // "2026-04"
      const { data: usage } = await admin
        .from("usage_limits")
        .select("image_count")
        .eq("line_user_id", lineUserId)
        .eq("year_month", yearMonth)
        .maybeSingle();

      const currentCount = (usage as any)?.image_count ?? 0;
      const imageCount = urls.length;

      if (currentCount + imageCount > 20) {
        return NextResponse.json(
          {
            error: `今月の利用上限（20枚）に達しました。来月またご利用ください。（現在: ${currentCount}枚使用済み）`,
          },
          { status: 429 },
        );
      }

      // 使用回数を更新
      await admin.from("usage_limits").upsert(
        {
          line_user_id: lineUserId,
          year_month: yearMonth,
          image_count: currentCount + imageCount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "line_user_id,year_month" },
      );
    }

    const { data: job, error: jobErr } = await admin
      .from("analysis_jobs")
      .insert({
        status: "queued",
        site_name,
        line_user_id: lineUserId,
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

    // バックグラウンドで処理（アプリを離れても継続）
    waitUntil((async () => {
      const maxSteps = urls.length + 3;
      for (let i = 0; i < maxSteps; i++) {
        const step = await processAnalysisJobStep({
          admin,
          jobId: job.id,
          headers: req.headers,
        });
        if (step.status === "done" || step.status === "failed") break;
      }
    })());

    return NextResponse.json({ success: true, job_id: job.id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
