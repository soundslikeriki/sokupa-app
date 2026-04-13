import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing or invalid 'text' field" }, { status: 400 });
    }

    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const userId = process.env.LINE_USER_ID;

    if (!channelAccessToken || !userId) {
      console.error("[LINE API] Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID in environment variables");
      // Don't fail the client request entirely if LINE is not configured, just return a warning
      return NextResponse.json({ 
        success: false, 
        message: "LINE credentials are not configured but processing finished successfully." 
      }, { status: 200 }); 
    }

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [
          {
            type: "text",
            text: text.trim(),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[LINE API Error]", response.status, errText);
      return NextResponse.json({ error: `LINE API responded with ${response.status}` }, { status: response.status });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[LINE API Exception]", error);
    return NextResponse.json({ error: "Failed to send line message" }, { status: 500 });
  }
}
