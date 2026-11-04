// Real route responses and browser rendering on loopback; all provider requests are synthetic.
const http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { NextRequest } = require('next/server');
const { GET: callback } = require('../../src/app/api/auth/line/callback/route.ts');
const { GET: start } = require('../../src/app/api/auth/line/route.ts');
let server, browser, checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
(async () => {
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) assert.equal(require('node:fs').existsSync(name), false);
  process.env.NODE_ENV = 'test';
  process.env.LINE_LOGIN_CHANNEL_ID = 'synthetic-channel';
  global.fetch = async () => { throw new Error('Real provider/API requests forbidden'); };
  server = http.createServer(async (req, res) => {
    try {
      const incoming = new NextRequest(`http://127.0.0.1:${server.address().port}${req.url}`, { headers: req.headers });
      const response = req.url.startsWith('/api/auth/line/callback') ? await callback(incoming) : req.url.startsWith('/api/auth/line') ? await start(incoming) : new Response('', { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.LINE_LOGIN_REDIRECT_URI = `${base}/api/auth/line/callback`;
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [], providers = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === base && url.pathname === '/api/auth/line') {
        // Do not let Chromium follow a local 302 to a real provider. Inspect that response instead.
        const response = await route.fetch({ maxRedirects: 0 });
        check(response.status() === 302, 'actual local start route issues a redirect');
        providers.push(new URL(response.headers().location));
        return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': response.headers()['set-cookie'] }, body: '<html lang="ja"><meta charset="utf-8"><body>模擬LINE画面</body></html>' });
      }
      if (url.origin === base) return route.continue();
      return route.abort();
    });
    const response = await page.goto(`${base}/api/auth/line/callback?code=synthetic-secret&state=foreign-browser`);
    check(response.status() === 400, 'foreign browser cannot authenticate');
    check((await response.headerValue('content-type')) === 'text/html; charset=utf-8', 'explicit UTF-8 HTML response');
    check((await page.locator('h1').innerText()) === 'ログインを確認してください', 'Japanese heading renders without mojibake');
    check(!(await page.locator('body').innerText()).includes('synthetic-secret'), 'OAuth code is not rendered');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
    await page.getByRole('link', { name: 'このブラウザでログインし直す' }).click();
    await page.waitForURL(`${base}/api/auth/line?browser=1`);
    if (!(providers.length === 1 && providers[0].searchParams.get('disable_auto_login') === 'true')) console.error(JSON.stringify({ providerRequests: providers.length, webRetryFlags: providers.map(url => url.searchParams.get('disable_auto_login')) }));
    check(providers.length === 1 && providers[0].searchParams.get('disable_auto_login') === 'true', 'retry stays in web authentication mode');
    check(providers[0].searchParams.get('redirect_uri') === `${base}/api/auth/line/callback`, 'retry uses the configured callback');
    const cookies = await page.context().cookies(base);
    check(cookies.some(cookie => cookie.name === 'sokupa_line_state' && cookie.httpOnly && cookie.sameSite === 'Lax'), 'retry creates new same-browser HttpOnly state');
    check(errors.length === 0, 'browser reports no script errors');
    await page.close();
  }
  console.log(JSON.stringify({ checks, widths: [390, 1280], actualSourceRoutes: true, realProviderRequests: 0, realLineSends: 0, browser: 'Chromium; iPhone Safari unverified' }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
});
