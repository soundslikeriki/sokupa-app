import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
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

    const google = createGoogleGenerativeAI({ apiKey });
    const result = await generateText({
      model: google("gemini-3-flash-preview"),
      prompt: "Hello, how are you?",
    });

    return NextResponse.json({ message: result.text });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("test-gemini:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
