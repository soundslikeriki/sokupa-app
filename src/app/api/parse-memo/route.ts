import { NextRequest, NextResponse } from "next/server";
import { requireJobSecret } from "@/lib/jobSecret";
export const runtime = "nodejs";
export const maxDuration = 300;
// OCR now requires a durable, quota-checked image lease and pre-send journal.
// Keep the route's auth boundary, but never offer an unjournaled alternate provider path.
export async function POST(req: NextRequest) {
  if (!requireJobSecret(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ error: "Use the durable analysis job worker" }, { status: 409 });
}
