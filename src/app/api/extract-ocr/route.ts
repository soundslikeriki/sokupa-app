import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  items: z.array(
    z.object({
      code: z.string(),
      amount: z.number(),
    }),
  ),
});

export async function POST(req: NextRequest) {
  try {
    const apiKey =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "GOOGLE_GENERATIVE_AI_API_KEY または GEMINI_API_KEY が未設定です" },
        { status: 500 },
      );
    }

    const { rawTextFromOcr } = (await req.json()) as { rawTextFromOcr?: string };
    if (typeof rawTextFromOcr !== "string" || !rawTextFromOcr.trim()) {
      return NextResponse.json({ error: "rawTextFromOcr が必要です" }, { status: 400 });
    }

    const google = createGoogleGenerativeAI({ apiKey });
    const result = await generateObject({
      model: google("gemini-3-flash-preview"),
      schema,
      prompt: `以下のテキストから品番と数量を抽出してください：${rawTextFromOcr}`,
    });

    return NextResponse.json(result.object);
  } catch (error: unknown) {
    console.error("extract-ocr:", error);
    return NextResponse.json({ error: "解析に失敗しました" }, { status: 500 });
  }
}
