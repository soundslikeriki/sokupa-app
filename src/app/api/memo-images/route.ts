import { analysisBackgroundReady } from "@/lib/analysis-background";
import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server-auth";
import { MAX_MEMO_BYTES, MEMO_BUCKET, UUID_PATTERN } from "@/lib/memo-storage";
import { readQaRuntime } from "@/lib/qa-runtime";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  if (!(await analysisBackgroundReady(auth.admin))) return NextResponse.json({ error: "解析サービスの準備ができていません。時間をおいて再度お試しください。" }, { status: 503 });
  const uploadId = req.headers.get("x-upload-id") ?? "";
  if (!UUID_PATTERN.test(uploadId)) return NextResponse.json({ error: "Invalid upload ID" }, { status: 400 });
  if (Number(req.headers.get("content-length")) > MAX_MEMO_BYTES) return NextResponse.json({ error: "画像が大きすぎます" }, { status: 413 });
  const reader = req.body?.getReader();
  if (!reader) return NextResponse.json({ error: "画像が必要です" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MEMO_BYTES) { await reader.cancel(); return NextResponse.json({ error: "画像が大きすぎます" }, { status: 413 }); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (size < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return NextResponse.json({ error: "JPEG画像が必要です" }, { status: 400 });
  const path = `${auth.lineUserId}/${uploadId}.jpg`;
  if (readQaRuntime()) {
    const reserved = await auth.admin.rpc("reserve_qa_upload", {p_owner:auth.lineUserId,p_bytes:size});
    if (reserved.error || reserved.data !== true) return NextResponse.json({error:"QAの試験上限または有効期限に達しました"},{status:429});
  }
  const { error } = await auth.admin.storage.from(MEMO_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (error) return NextResponse.json({ error: "画像の保存に失敗しました" }, { status: 503 });
  return NextResponse.json({ object_path: path });
}
