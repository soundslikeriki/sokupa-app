import { NextRequest, NextResponse } from "next/server";
import { requireJobSecret } from "@/lib/jobSecret";
import { parseMemoBody } from "@/lib/parseMemo";
export const runtime = "nodejs";
export const maxDuration = 300;
// Only the job worker may invoke OCR; public callers must pass quota-checked job creation.
export async function POST(req: NextRequest) {
  if (!requireJobSecret(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return parseMemoBody(await req.json());
}
