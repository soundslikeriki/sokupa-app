import { readQaRuntime, QaRuntimeError } from "./qa-runtime";
/** LINE de-duplicates retries using the stable job UUID, including a lost HTTP response. */
export async function sendLineMessages(to: string, messages: { type: string; text: string }[], retryKey?: string, fetcher: typeof fetch = fetch) {
  const qa = readQaRuntime();
  if (qa) {
    if (to !== qa.ownerLineUserId || !messages.length) throw new QaRuntimeError();
    console.info("[qa] synthetic notification accepted");
    return;
  }
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !to) throw new Error("LINE通知が未設定です");
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (retryKey) headers["X-Line-Retry-Key"] = retryKey;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher("https://api.line.me/v2/bot/message/push", {
        method: "POST", headers, body: JSON.stringify({ to, messages }), signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || (retryKey && response.status === 409 && response.headers.get("x-line-accepted-request-id"))) return;
      if (attempt === 0 && retryKey && response.status >= 500) continue;
      throw new Error(`LINE HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 0 && retryKey && !(error instanceof Error && error.message.startsWith("LINE HTTP"))) continue;
      throw error;
    }
  }
}
