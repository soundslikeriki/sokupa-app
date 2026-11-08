const workspace = require('./result-workspace-helpers.cjs');
// Synthetic fixtures only. Every request outside the local app is aborted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3317';
const user = 'synthetic-user', a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b', c = '00000000-0000-4000-8000-00000000000c';
const key = `sokupa:workspace:v1:${user}`, pointer = `sokupa:lastJobId:${user}`, cachedA = `${key}:recovery:result:${a}`;
const item = (code, quantity, order) => ({ product_code: code, manufacturer: 'Synthetic', entries: [{ original_formula: '20×1', length_m: 20, quantity, subtotal_m: 20 * quantity }], total_m: 20 * quantity, order_quantity: order });
const saved = { version: 1, siteName: 'Saved B', parsed: { items: [item('B-CODE', 2, 46)] }, originalParsed: { items: [item('B-CODE', 1, 23)] }, resultJobId: b, orderDraftItems: [] };
const wait = async (fn) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('synthetic recovery condition timed out'); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  let checks = 0;
  async function fixture(options = {}) {
    const state = { remoteSeen: false, accepted: false, detailReady: true, initialPointer: true, createStatus: 503, created: false, doneC: false, seenA: 0, seenC: 0, readsA: 0, creates: 0, historyReads: 0, historyFailed: false, ...options };
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, acceptDownloads: true }), page = await context.newPage();
 await workspace.freshResultFixtures(context);
    page.on('pageerror', e => { throw e; });
    await context.addInitScript(({ key, pointer, a, saved, initialPointer }) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, JSON.stringify(saved)); if (initialPointer) localStorage.setItem(pointer, a); sessionStorage.setItem('seeded', 'yes'); }
    }, { key, pointer, a, saved, initialPointer: state.initialPointer });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { authenticated: true, line_user_id: user } });
      if (url.pathname === '/api/analysis-jobs' && route.request().method() === 'GET') {
        if (url.searchParams.get('history') === '1') {
          state.historyReads++;
          if (!state.historyFailed) { state.historyFailed = true; return route.fulfill({ status: 503, json: { error: 'Synthetic history outage' } }); }
          const row = (id, site) => ({ id, site_name: site, created_at: '2026-11-03T00:00:00Z', notification_status: 'accepted' });
          return route.fulfill({ json: { data: url.searchParams.has('before') ? [row(a, 'Server A')] : [row(c, 'Saved B')], next_before: url.searchParams.has('before') ? null : c } });
        }
        return route.fulfill({ json: { data: [ ...(state.created && !state.seenC ? [{ id: c, status: state.doneC ? 'done' : 'running', site_name: 'Saved B', client_result_seen_at: null, notification_status: 'accepted' }] : []), ...(!state.remoteSeen || !state.accepted ? [{ id: a, status: 'done', site_name: 'Server A', client_result_seen_at: state.remoteSeen ? 'remote' : null, notification_status: state.accepted ? 'accepted' : 'failed' }] : []) ] } });
      }
      if (url.pathname === '/api/analysis-jobs') {
        state.creates++;
        if (state.createStatus !== 200) return route.fulfill({ status: 503, json: { error: 'Synthetic new admission failure' } });
        state.created = true;
        return route.fulfill({ json: { success: true, job_id: c, execution_mode: 'scheduled-wake', background_ready: true } });
      }
      if (url.pathname === '/api/memo-images') return route.fulfill({ json: { object_path: user + '/synthetic.jpg' } });
      if (url.pathname === `/api/analysis-jobs/${a}`) {
        state.readsA++;
        if (!state.detailReady) return route.fulfill({ status: 503, json: { error: 'Synthetic old result outage' } });
        return route.fulfill({ json: { data: { id: a, status: 'done', site_name: 'Server A', result: { items: [item('A-CODE', 1, 23)] }, client_result_seen_at: state.remoteSeen ? 'remote' : null, notification_status: state.accepted ? 'accepted' : 'failed', total_images: 1, done_images: 1, can_resume: !state.accepted, execution_mode: 'scheduled-wake', background_ready: true } } });
      }
      if (url.pathname === `/api/analysis-jobs/${c}`) return route.fulfill({ json: { data: { id: c, status: state.doneC ? 'done' : 'running', site_name: 'Saved B', result: state.doneC ? { items: [item('C-CODE', 1, 23)] } : null, notification_status: 'accepted', client_result_seen_at: state.seenC ? 'stored' : null, total_images: 1, done_images: state.doneC ? 1 : 0, can_resume: false, execution_mode: 'scheduled-wake', background_ready: true } } });
      if (url.pathname === `/api/analysis-jobs/${a}/resume`) return route.fulfill({ status: 202, json: { success: true } });
      if (url.pathname === `/api/analysis-jobs/${a}/seen`) { state.seenA++; return route.fulfill({ json: { success: true } }); }
      if (url.pathname === `/api/analysis-jobs/${b}/seen`) return route.fulfill({ json: { success: true } });
      if (url.pathname === `/api/analysis-jobs/${c}/seen`) { state.seenC++; return route.fulfill({ json: { success: true } }); }
      if (url.pathname.startsWith('/api/')) throw Error('Unexpected API ' + url.pathname);
      return route.continue();
    });
    const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const upload = async () => { const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; return canvas.toDataURL('image/png').split(',')[1]; }); await workspace.disclosure(page, '画像・現場名'); await page.locator('input[type=file]').setInputFiles({ name: 'next.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await page.getByAltText('プレビュー 1', { exact: true }).waitFor(); };
    await page.goto(base); await workspace.edit(page, 'B-CODE'); await page.getByLabel('B-CODE の発注数量を入力', { exact: true }).waitFor();
    return { context, page, state, read, upload };
  }
  try {
    // Explicit deferral survives another device's seen receipt, terminal notification and offline reload.
    {
      const f = await fixture(), { page, state } = f;
      await page.getByText('別の解析結果があります', { exact: true }).waitFor(); checks++;
      await page.getByRole('button', { name: '今の編集を続ける', exact: true }).click();
      await page.getByText('今の編集を続けています。',{exact:true}).waitFor();
      assert.equal(JSON.parse(await page.evaluate(k => localStorage.getItem(k), cachedA)).resultJobId, a); assert.equal(state.seenA, 0); checks++;
      state.remoteSeen = state.accepted = true;
      await page.getByText('Server A: LINE受付済み', { exact: true }).waitFor();
      assert.equal(await page.evaluate(k => localStorage.getItem(k), pointer), a); assert.equal((await f.read()).parsed.items[0].order_quantity, 46); checks++;
      state.detailReady = false; await page.reload(); await workspace.mode(page, '実寸計測'); await page.getByText(/^退避した下書きを確認/).click();
      await page.getByRole('button', { name: /「Server A」を復元/ }).first().click();
      await workspace.edit(page, 'A-CODE'); await page.getByLabel('A-CODE の発注数量を入力', { exact: true }).waitFor();
      assert.equal((await f.read()).resultJobId, a); assert.ok(state.seenA > 0); assert.equal(await page.getByRole('tab',{name:'概要',exact:true}).isVisible(),true); checks++;
      assert.ok(await page.evaluate(({ key, b }) => Object.keys(localStorage).filter(k => k.startsWith(key + ':recovery:')).some(k => { const d = JSON.parse(localStorage.getItem(k)); return d.resultJobId === b && d.parsed.items[0].order_quantity === 46; }), { key, b })); checks++;
      await f.context.close();
    }
    // An explicit old pointer cannot be discarded solely because another device saw it first.
    {
      const f = await fixture({ remoteSeen: true }), { page, state } = f;
      await page.getByText('別の解析結果があります', { exact: true }).waitFor(); assert.equal(state.seenA, 0); checks++;
      state.accepted = true; await page.getByText('Server A: LINE受付済み', { exact: true }).waitFor();
      assert.equal(await page.evaluate(k => localStorage.getItem(k), pointer), a); checks++;
      await page.reload(); await page.getByText('別の解析結果があります', { exact: true }).waitFor();
      await workspace.mode(page, '発注リスト'); await page.getByRole('button', { name: '選択した以前のデータを復元する', exact: true }).click();
      await workspace.edit(page, 'A-CODE'); await page.getByLabel('A-CODE の発注数量を入力', { exact: true }).waitFor(); assert.equal((await f.read()).resultJobId, a); checks++;
      await f.context.close();
    }
    // Failed new admission resumes the suspended old result read, without a reload.
    {
      const f = await fixture({ detailReady: false, initialPointer: false }), { page, state } = f;
      await page.getByText('解析が完了しました', { exact: true }).waitFor();
      await f.upload(); await page.getByRole('button', { name: '1枚の画像を解析する', exact: true }).click();
      await page.getByText('Synthetic new admission failure', { exact: false }).waitFor(); assert.equal(state.creates, 1); checks++;
      state.detailReady = true; await page.getByText('別の解析結果があります', { exact: true }).waitFor();
      assert.equal((await f.read()).parsed.items[0].order_quantity, 46); assert.equal(state.seenA, 0); checks++;
      assert.equal(await page.getByRole('button', { name: '1枚の画像を解析する', exact: true }).isEnabled(), true); checks++;
      await f.context.close();
    }
    // Storage failure never silently confirms deferral; paged owner history recovers A after new job C.
    {
      const f = await fixture({ createStatus: 200 }), { page, state } = f;
      await page.getByText('別の解析結果があります', { exact: true }).waitFor();
      await page.evaluate(cachedA => { window.realCacheSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === cachedA) throw new DOMException('Synthetic full result cache', 'QuotaExceededError'); return window.realCacheSet.call(this, k, v); }; }, cachedA);
      await page.getByRole('button', { name: '今の編集を続ける', exact: true }).click();
      await page.getByText('選択したデータを端末へ保管できませんでした。', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '別の結果を確認する', exact: true }).count(), 0); assert.equal(state.seenA, 0); checks++;
      await f.upload(); await page.getByRole('button', { name: '1枚の画像を解析する', exact: true }).click();
      await page.getByText('解析を受け付けました', { exact: true }).waitFor();
      assert.equal(await page.evaluate(k => localStorage.getItem(k), pointer), c); assert.equal(await page.evaluate(k => localStorage.getItem(k), cachedA), null); checks++;
      state.remoteSeen = state.accepted = state.doneC = true;
      await workspace.edit(page, 'C-CODE'); await page.getByLabel('C-CODE の発注数量を入力', { exact: true }).waitFor();
      await page.reload(); await workspace.edit(page, 'C-CODE'); await page.getByLabel('C-CODE の発注数量を入力', { exact: true }).waitFor();
      await workspace.disclosure(page, '保存済みの結果を開く'); await page.getByRole('button', { name: '保存済みの解析結果を探す', exact: true }).click();
      await page.getByText('保存済みの解析結果を取得できませんでした。', { exact: false }).waitFor(); assert.equal((await f.read()).resultJobId, c); checks++;
      await workspace.disclosure(page, '保存済みの結果を開く'); await page.getByRole('button', { name: '保存済みの解析結果を探す', exact: true }).click();
      await page.getByRole('button', { name: 'さらに前の結果を探す', exact: true }).click();
      await page.getByRole('button', { name: '保存済み「Server A」の結果を確認', exact: true }).click();
      await page.getByText('別の解析結果があります', { exact: true }).waitFor(); assert.equal((await f.read()).resultJobId, c); assert.equal(state.seenA, 0); checks++;
      await page.getByRole('button', { name: '選択した以前のデータを復元する', exact: true }).click();
      await workspace.edit(page, 'A-CODE'); await page.getByLabel('A-CODE の発注数量を入力', { exact: true }).waitFor(); assert.equal((await f.read()).resultJobId, a); assert.ok(state.historyReads >= 3); checks++;
      assert.ok(await page.evaluate(({ key, c }) => Object.keys(localStorage).filter(k => k.startsWith(key + ':recovery:')).some(k => JSON.parse(localStorage.getItem(k)).resultJobId === c), { key, c })); checks++;
      await f.context.close();
    }
    console.log(`PASS: ${checks} deferred-result recovery checks; remote seen/accepted, offline cache restore, explicit pointer, admission 503 recovery, quota failure and paged history; no external requests.`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
