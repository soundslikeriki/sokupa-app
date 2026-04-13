import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

type CorrectionPayload = {
  site_name?: string;
  kind: "product_code" | "quantity" | "other";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CorrectionPayload;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    if (!body.kind) {
      return NextResponse.json({ error: "Missing kind" }, { status: 400 });
    }
    const admin = createSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Supabase admin not configured" }, { status: 500 });
    }

    const site_name = typeof body.site_name === "string" ? body.site_name.trim() : null;
    const kind = body.kind;
    const before = body.before ?? {};
    const after = body.after ?? {};

    const { error } = await admin.from("memo_corrections").insert({
      site_name,
      kind,
      before,
      after,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

