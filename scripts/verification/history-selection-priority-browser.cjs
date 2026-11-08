const workspace = require('./result-workspace-helpers.cjs');
// Delayed automatic lookup must never replace an explicitly selected history result.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3317';
const user = 'synthetic-history-priority', a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b', c = '00000000-0000-4000-8000-00000000000c';
const key = `sokupa:workspace:v1:${user}`, pointer = `sokupa:lastJobId:${user}`;
const memo = (code, length, quantity, order) => ({ items: [{ product_code: code, manufacturer: 'Synthetic', entries: [{ original_formula: `${length}×${quantity}`, length_m: length, quantity, subtotal_m: length * quantity }], total_m: length * quantity, order_quantity: order }] });
const saved = { version: 1, siteName: 'Editing B', parsed: memo('B-CODE', 20, 2, 46), originalParsed: memo('B-CODE', 20, 1, 23), resultJobId: b, orderDraftItems: [] };
const wait = async fn => { const until = Date.now() + 15000; while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('history priority condition timed out'); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let checks = 0;
  try {
    for (const scenario of ['delayed-list', 'delayed-pointer', 'same-history-selected-twice']) {
      let release, automaticReads = 0, cReads = 0, aReads = 0, nonBSeen = 0;
      const gate = new Promise(resolve => { release = resolve; });
      const context = await browser.newContext({ viewport: { width: 375, height: 900 } }), page = await context.newPage();
 await workspace.freshResultFixtures(context);
      page.on('pageerror', error => { throw error; });
      await context.addInitScript(({ key, pointer, saved, c, hasPointer }) => { localStorage.setItem(key, JSON.stringify(saved)); if (hasPointer) localStorage.setItem(pointer, c); }, { key, pointer, saved, c, hasPointer: scenario !== 'same-history-selected-twice' });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        if (url.pathname === '/api/auth/session') return route.fulfill({ json: { authenticated: true, line_user_id: user } });
        if (url.pathname === '/api/analysis-jobs') {
          if (url.searchParams.get('history') === '1') return route.fulfill({ json: { data: [{ id: a, site_name: 'Historical A', created_at: '2026-11-01T00:00:00Z', notification_status: 'accepted' }], next_before: null } });
          automaticReads++;
          if (scenario === 'delayed-list') await gate;
          return route.fulfill({ json: { data: scenario === 'same-history-selected-twice' ? [] : [{ id: c, status: 'done', site_name: 'Pointer C', notification_status: 'accepted', client_result_seen_at: null }] } });
        }
        if (url.pathname.endsWith('/seen')) { if (url.pathname !== `/api/analysis-jobs/${b}/seen`) nonBSeen++; return route.fulfill({ json: { success: true } }); }
        if (url.pathname === `/api/analysis-jobs/${a}` || url.pathname === `/api/analysis-jobs/${c}`) {
          const isA = url.pathname.endsWith(a);
          if (isA) { aReads++; if (scenario === 'same-history-selected-twice' && aReads === 1) { await gate; return route.fulfill({ status: 503, json: { error: 'Synthetic superseded result failure' } }); } }
          else { cReads++; if (scenario === 'delayed-pointer') await gate; }
          return route.fulfill({ json: { data: { id: isA ? a : c, status: 'done', site_name: isA ? 'Historical A' : 'Pointer C', result: isA ? memo('A-CODE', 10, 1, 12) : memo('C-CODE', 23, 1, 23), notification_status: 'accepted', client_result_seen_at: 'remote', total_images: 1, done_images: 1, can_resume: false, background_ready: true, execution_mode: 'scheduled-wake' } } });
        }
        if (url.pathname.startsWith('/api/')) throw Error('Unexpected API ' + url.pathname);
        return route.continue();
      });
      try {
        await page.goto(base); await workspace.edit(page, 'B-CODE'); await page.getByLabel('B-CODE の発注数量を入力', { exact: true }).waitFor();
        if (scenario === 'delayed-list') { await page.getByText('別の解析: C-CODE: 23m', { exact: true }).waitFor(); await wait(() => automaticReads >= 1); }
        if (scenario === 'delayed-pointer') await wait(() => cReads >= 1);
        checks++;
        await workspace.disclosure(page, '保存済みの結果を開く'); await page.getByRole('button', { name: '保存済みの解析結果を探す', exact: true }).click();
        const historyButton = page.getByRole('button', { name: '保存済み「Historical A」の結果を確認', exact: true });
        const beforeC = cReads, beforeAutomatic = automaticReads;
        await historyButton.click();
        if (scenario === 'same-history-selected-twice') { await wait(() => aReads === 1); await historyButton.click(); }
        await page.getByText('別の解析: A-CODE: 12m', { exact: true }).waitFor();
        assert.equal(JSON.parse(await page.evaluate(k => localStorage.getItem(k), key)).parsed.items[0].order_quantity, 46); assert.equal(nonBSeen, 0); checks++;
        const latePath = scenario === 'delayed-list' ? '/api/analysis-jobs' : `/api/analysis-jobs/${scenario === 'delayed-pointer' ? c : a}`;
        const lateResponse = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === latePath && !url.searchParams.has('history'); });
        release(); const response = await lateResponse; await response.finished(); await page.waitForTimeout(200);
        assert.equal(await page.getByText('別の解析: A-CODE: 12m', { exact: true }).count(), 1);
        assert.equal(await page.getByText('別の解析: C-CODE: 23m', { exact: true }).count(), 0);
        assert.equal(cReads, beforeC); assert.equal(automaticReads, beforeAutomatic + (scenario === 'delayed-pointer' ? 1 : 0)); assert.equal(nonBSeen, 0); checks++;
        if (scenario === 'same-history-selected-twice') { assert.equal(aReads, 2); assert.equal(await page.getByText('結果を取得できません。', { exact: false }).count(), 0); checks++; }
        await page.getByRole('button', { name: '今の編集を残して選んだ結果を開く', exact: true }).click();
        await workspace.edit(page, 'A-CODE'); await page.getByLabel('A-CODE の発注数量を入力', { exact: true }).waitFor();
        const applied = JSON.parse(await page.evaluate(k => localStorage.getItem(k), key)); assert.equal(applied.resultJobId, a); assert.equal(applied.parsed.items[0].order_quantity, 12); checks++;
        assert.ok(await page.evaluate(({ key, b }) => Object.keys(localStorage).filter(k => k.startsWith(key + ':recovery:')).some(k => { const draft = JSON.parse(localStorage.getItem(k)); return draft.resultJobId === b && draft.parsed.items[0].order_quantity === 46; }), { key, b })); checks++;
      } finally { release(); await context.close(); }
    }
    console.log(`PASS: ${checks} history selection priority browser checks; delayed discovery/pointer, repeated explicit selection, stale failure and edited draft safety; no external requests.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
