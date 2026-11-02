import test from "node:test";
import assert from "node:assert/strict";
import { sendLineMessages } from "./line-notification";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-only-not-a-real-token";

test("LINE retries a server failure with the same key and accepts a deduplicated response", async () => {
  const keys: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("X-Line-Retry-Key")!);
    return keys.length === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "accepted" } });
  };
  await sendLineMessages("fake-user", [{ type: "text", text: "test" }], "00000000-0000-4000-8000-000000000000", fetcher);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("LINE HTTP failure is not success and client errors are not blindly retried", async () => {
  let calls = 0;
  await assert.rejects(sendLineMessages("fake-user", [], "00000000-0000-4000-8000-000000000000", async () => { calls++; return new Response(null, { status: 401 }); }), /LINE HTTP 401/);
  assert.equal(calls, 1);
});
