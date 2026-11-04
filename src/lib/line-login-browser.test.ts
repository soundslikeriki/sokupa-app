import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as start } from "../app/api/auth/line/route";
import { GET as callback } from "../app/api/auth/line/callback/route";

const origin = "https://sokupa.example.test";
const configure = () => {
  process.env.LINE_LOGIN_CHANNEL_ID = "synthetic-channel";
  process.env.LINE_LOGIN_REDIRECT_URI = `${origin}/api/auth/line/callback`;
};

test("alias login first moves to callback origin without setting a wrong-origin cookie", async () => {
  configure();
  const response = await start(new NextRequest("https://alias.example.test/api/auth/line?browser=1&state=attacker&return_to=https://attacker.test"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/api/auth/line?browser=1`);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("canonical normal flow keeps automatic login and browser retry explicitly disables it", async () => {
  configure();
  const first = await start(new NextRequest(`${origin}/api/auth/line`));
  const retry = await start(new NextRequest(`${origin}/api/auth/line?browser=1`));
  const a = new URL(first.headers.get("location")!), b = new URL(retry.headers.get("location")!);
  assert.equal(a.hostname, "access.line.me");
  assert.equal(a.searchParams.get("disable_auto_login"), null);
  assert.equal(b.searchParams.get("disable_auto_login"), "true");
  assert.equal(b.searchParams.get("ui_locales"), "ja");
  assert.equal(b.searchParams.get("redirect_uri"), `${origin}/api/auth/line/callback`);
  assert.notEqual(a.searchParams.get("state"), b.searchParams.get("state"));
  assert.match(retry.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(retry.headers.get("set-cookie")!, /SameSite=lax/);
  assert.equal(retry.headers.get("cache-control"), "no-store");
});

test("loopback callback normalization does not create a local login redirect loop", async () => {
  process.env.LINE_LOGIN_CHANNEL_ID = "synthetic-channel";
  process.env.LINE_LOGIN_REDIRECT_URI = "http://127.0.0.1:3318/api/auth/line/callback";
  const response = await start(new NextRequest("http://127.0.0.1:3318/api/auth/line?browser=1"));
  assert.equal(new URL(response.headers.get("location")!).hostname, "access.line.me");
});

test("missing, foreign-browser and overwritten state never exchange a code; errors render UTF-8 recovery", async () => {
  const saved = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error("Network must remain unused"); };
  try {
    for (const cookie of ["", "sokupa_line_state=other-browser", "sokupa_line_state=newer-attempt"]) {
      const response = await callback(new NextRequest(`${origin}/api/auth/line/callback?code=never-exchange-secret&state=old-attempt`, { headers: { cookie } }));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
      const html = await response.text();
      assert.match(html, /<meta charset="utf-8">/);
      assert.match(html, /ログインを確認してください/);
      assert.match(html, /href="\/api\/auth\/line\?browser=1"/);
      assert.equal(html.includes("never-exchange-secret"), false);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.cookies.get("sokupa_session"), undefined);
    }
    assert.equal(calls, 0);
  } finally { global.fetch = saved; }
});

test("provider cancel and malformed callback use a recoverable page without echoing provider input", async () => {
  for (const query of ["error=ACCESS_DENIED&error_description=%3Cscript%3E", "", "code=secret"]) {
    const response = await callback(new NextRequest(`${origin}/api/auth/line/callback?${query}`));
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("secret"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("invalid callback configuration never redirects to a credential-bearing or wrong-path URL", async () => {
  configure();
  for (const uri of ["https://user:password@example.test/api/auth/line/callback", `${origin}/other`, `${origin}/api/auth/line/callback#secret`]) {
    process.env.LINE_LOGIN_REDIRECT_URI = uri;
    const response = await start(new NextRequest(`${origin}/api/auth/line`));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
  }
});
