import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { MEMO_BUCKET, MAX_MEMO_BYTES, UUID_PATTERN, memoObjectPath } from "@/lib/memo-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { id, index } = await params;
  if (!UUID_PATTERN.test(id) || !/^[0-4]$/.test(index)) return NextResponse.json({ error: "Invalid image" }, { status: 400 });
  const job = await auth.admin.from("analysis_jobs").select("id").eq("id", id).eq("line_user_id", auth.lineUserId).maybeSingle();
  if (job.error) return NextResponse.json({ error: "写真を確認できませんでした" }, { status: 503 });
  if (!job.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const image = await auth.admin.from("analysis_job_images").select("url").eq("job_id", id).eq("idx", Number(index)).maybeSingle();
  if (image.error) return NextResponse.json({ error: "写真を確認できませんでした" }, { status: 503 });
  if (!image.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const objectPath = memoObjectPath(image.data.url, process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const downloaded = await auth.admin.storage.from(MEMO_BUCKET).download(objectPath);
    if (downloaded.error || !downloaded.data || downloaded.data.size > MAX_MEMO_BYTES) throw new Error("Unavailable");
    const mime = downloaded.data.type.split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("Unsupported image");
    return new NextResponse(downloaded.data, { headers: { "Content-Type": mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'" } });
  } catch { return NextResponse.json({ error: "写真を取得できませんでした" }, { status: 503 }); }
}
