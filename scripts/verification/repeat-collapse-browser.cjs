// Actual local builds, synthetic storage/API responses only. Not physical iPhone Safari.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const ui = require('./result-workspace-helpers.cjs');
const { planMemoOrder } = require('../../src/lib/order-planning.ts');
const bases = [process.env.SOKUPA_TEST_URL, process.env.SOKUPA_BASIC_URL];
for (const base of bases) assert.equal(new URL(base).hostname, '127.0.0.1');
const DAY = 86400000, now = Date.now(), owner = 'synthetic-repeat-collapse';
const key = 'sokupa:workspace:v1:' + owner, job = '00000000-0000-4000-8000-00000000000a';
const item = {
 product_code: 'SYN-A', manufacturer: 'Synthetic', measurement_basis: 'trim-included',
 pattern_match: 'straight', repeat_cm: 60, order_mode: 'pattern', pattern_rows_configured: true,
 loss_rate_percent: 15, total_m: 10.2, order_quantity: 12,
 entries: [{ source_row_id: 'a', original_formula: '2.7×2', length_m: 2.7, quantity: 2, subtotal_m: 5.4, repeat_enabled: true },
 { source_row_id: 'b', original_formula: '3.8×1', length_m: 3.8, quantity: 1, subtotal_m: 3.8, repeat_enabled: true }],
};
item.reading_reviews = [{ reason: 'Synthetic correction to review', candidate_formulas: ['1×2'], source_image_index: 0 }];
item.reading_review_confirmation = planMemoOrder({ item, rows: item.entries.map(e => ({ id: e.source_row_id, length: e.length_m, quantity: e.quantity, active: true })), repeatCm: 60, basis: 'trim-included', match: 'straight', lossRate: 15 }).readingReviewFingerprint;
item.quantity_confirmation = 'synthetic-legacy-quantity-flag';
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); console.log('PASS ' + (++checks) + ': ' + message); };
const wait = async fn => { for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error('Repeat collapse condition timed out'); };
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
 try {
  const fixture = async (base, mode, width, touch = false) => {
   const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch }), errors = [], unexpected = [], dialogs = [];
   await ui.freshResultFixtures(context);
   await context.addInitScript(({ key, item, job, now }) => {
    if (!localStorage.getItem('collapse-clock')) localStorage.setItem('collapse-clock', String(now));
    Date.now = () => Number(localStorage.getItem('collapse-clock'));
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, siteName: 'Next synthetic site', resultSiteName: 'Synthetic result',
     resultJobId: job, parsed: { items: [item, { ...structuredClone(item), product_code: 'SYN-B' }] },
     originalParsed: { items: [item, { ...structuredClone(item), product_code: 'SYN-B' }] },
     orderDraftItems: [{ id: 'keep', productCode: 'KEEP', quantity: 7, unit: 'm', sourceType: 'manual', sourceLabel: 'Synthetic' }] }));
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (window.failCollapseSave && name === key) throw Error('Synthetic write failure'); return write.call(this, name, value); };
    const lockRequest = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, ...args) => {
     const callback = args.pop();
     return lockRequest(name, ...args, async lock => {
      if (window.holdCollapseSave && name.includes('workspace')) {
       window.collapseLockHeld = true;
       await new Promise(resolve => { window.releaseCollapseSave = () => { window.holdCollapseSave = false; resolve(); }; });
      }
      return callback(lock);
     });
    };
   }, { key, item, job, now });
   await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin !== base) { unexpected.push(u.origin); return route.abort(); }
    if (!u.pathname.startsWith('/api/')) return route.continue();
    if (u.pathname === '/api/auth/session') return route.fulfill({ json: { authenticated: true, line_user_id: owner, admin: true } });
    if (u.pathname === '/api/analysis-jobs' && req.method() === 'GET') return route.fulfill({ json: { data: [] } });
    if (u.pathname.endsWith('/seen')) return route.fulfill({ json: { success: true } });
    if (u.pathname === '/api/analysis-jobs/' + job) return route.fulfill({ json: { data: { id: job, total_images: 1 } } });
    if (u.pathname === '/api/analysis-jobs/' + job + '/images/0') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64') });
    unexpected.push(req.method() + ' ' + u.pathname); return route.abort();
   });
   const page = await context.newPage();
   page.on('pageerror', e => errors.push(e.message));
   page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
   await page.goto(base); await ui.edit(page, 'SYN-A');
   const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
   const toggle = () => page.getByRole('button', { name: 'SYN-A の数量・リピート', exact: true });
   const height = () => page.getByLabel('SYN-A の壁の高さ (m)', { exact: true });
   const repeat = () => page.getByLabel('SYN-A のリピート (cm)', { exact: true });
   const saved = async () => {
    let before = '', stable = 0;
    await wait(async () => {
     const value = JSON.stringify(await read());
     stable = value === before ? stable + 1 : 0; before = value;
     return stable >= 3 && (await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');
    });
   };
   const act = async () => touch ? toggle().tap() : toggle().click();
   const ack = () => page.getByLabel('SYN-A の訂正・取消を確認済みにする', { exact: true });
   await saved();
   return { context, page, read, toggle, height, repeat, saved, act, ack, errors, unexpected, dialogs };
  };
  for (const [mode, base] of bases.entries()) for (const width of [320, 390]) for (const touch of [false, true]) {
   const h = await fixture(base, mode, width, touch), { page } = h;
   const target = await h.toggle().getAttribute('aria-controls');
   check(await h.toggle().getAttribute('aria-expanded') === 'true' && await h.height().isVisible(), 'default expanded: height/repeat directly editable');
   check(await page.locator('[id]').evaluateAll(els => { const ids = els.map(e => e.id); return new Set(ids).size === ids.length; }), 'controls and existing IDs are unique');
   const box = await h.toggle().boundingBox(); check(box.height >= 44 && box.width >= 44, 'heading has at least44px touch target');
   check(await page.getByRole('group', { name: 'SYN-A の数量・リピート', exact: true }).count() === 1, 'existing fieldset has an unambiguous accessible name');
   check(await page.getByRole('checkbox', { name: /必要量の前提|メモと発注数量/ }).count() === 0, 'obsolete quantity acknowledgement is absent'); await h.saved();
   const confirmed = await h.read();
   check(Boolean(confirmed.parsed.items[0].reading_review_confirmation) && confirmed.parsed.items[0].quantity_confirmation === 'synthetic-legacy-quantity-flag', 'fixture retains its existing source review and legacy quantity flag without generating a new one');
   await page.evaluate(now => localStorage.setItem('collapse-clock', String(now + 3600000)), now);
   await h.act();
   check(await h.toggle().getAttribute('aria-expanded') === 'false' && await h.height().isHidden(), 'one heading click/tap collapses the existing controls');
   check(await h.height().count() === 1 && await page.locator('[id="' + target + '"]').getAttribute('hidden') !== null, 'inputs stay mounted and controlled panel is hidden');
   check(await h.toggle().evaluate(el => el === document.activeElement), 'collapse returns focus to the visible heading');
   await page.keyboard.press('Tab');
   check(await page.evaluate(id => !document.getElementById(id).contains(document.activeElement), target), 'Tab cannot enter hidden controls');
   await h.saved();
   check(JSON.stringify(await h.read()) === JSON.stringify(confirmed), 'collapse does not change data, confirmation, draft or24/48h clock');
   await ui.view(page, '概要');
   check(await page.getByRole('button', { name: '確認してコピー', exact: true }).isVisible(), 'safe copy/review entry remains reachable from overview');
   await ui.edit(page, 'SYN-A');
   check(await h.toggle().getAttribute('aria-expanded') === 'false', 'collapse survives result-tab navigation');
   await h.toggle().focus(); await h.toggle().press('Enter');
   check(await h.toggle().getAttribute('aria-expanded') === 'true' && await h.height().isVisible(), 'Enter expands and preserves direct height editing');
   await h.toggle().press('Space'); check(await h.toggle().getAttribute('aria-expanded') === 'false', 'Space collapses');
   await h.toggle().press('Space'); check(await h.toggle().getAttribute('aria-expanded') === 'true', 'Space expands');
   check(await h.ack().isChecked(), 'existing confirmation remains after all disclosures');
   await h.height().fill('2.7'); await h.saved();
   check((await h.read()).parsed.items[0].repeat_height_m === 2.7 && !(await h.read()).parsed.items[0].quantity_confirmation, 'explicit common-height edit recalculates and invalidates confirmation normally');
   await h.repeat().fill(''); await h.saved(); const incomplete = await h.read();
   await h.act(); await ui.view(page, 'メモ画像'); await ui.edit(page, 'SYN-A'); await h.act();
   check(await h.repeat().inputValue() === '' && JSON.stringify(await h.read()) === JSON.stringify(incomplete), 'unfinished repeat input survives collapse/tab round-trip without implicit save');
   check(await page.getByRole('button', { name: '発注リストに追加', exact: true }).filter({ visible: true }).first().isEnabled(), 'incomplete repeat warns but does not block a valid chosen order');
   await page.reload(); await ui.edit(page, 'SYN-A'); await h.saved();
   check(await h.toggle().getAttribute('aria-expanded') === 'true' && await h.repeat().inputValue() === '' && await h.height().inputValue() === '2.7', 'reload opens controls while restoring raw input and common height');
   check((await h.read()).orderDraftItems[0].productCode === 'KEEP' && (await h.read()).siteName === 'Next synthetic site', 'order draft and next-site inputs remain intact');
   await h.repeat().fill('60'); await h.saved();
   await page.evaluate(() => { window.holdCollapseSave = true; });
   await h.height().fill('2.8');
   await wait(() => page.evaluate(() => Boolean(window.collapseLockHeld)));
   await h.act();
   check(await h.toggle().getAttribute('aria-expanded') === 'false', 'collapse remains usable while save lock is pending');
   await page.evaluate(() => window.releaseCollapseSave()); await h.saved(); await h.act();
   check(await h.height().inputValue() === '2.8' && (await h.read()).parsed.items[0].repeat_height_m === 2.8, 'queued save converges once without losing hidden input');
   await page.evaluate(() => { window.failCollapseSave = true; }); await h.height().fill('2.9');
   await wait(() => page.getByRole('button', { name: '保存できない現在の内容を書き出す', exact: true }).isVisible());
   await h.act();
   check(await page.getByRole('button', { name: '保存できない現在の内容を書き出す', exact: true }).isVisible(), 'save failure/recovery is visible even when controls are closed');
   await h.act(); check(await h.height().inputValue() === '2.9', 'save failure never discards the visible/raw height draft');
   await page.evaluate(() => { window.failCollapseSave = false; });
   check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at narrow width');
   if(h.errors.length||h.unexpected.length)console.log('SYNTHETIC_DIAGNOSTIC',JSON.stringify({mode,width,touch,errors:h.errors,unexpected:h.unexpected}));
   check(h.errors.length === 0 && h.unexpected.length === 0, 'no runtime, provider, LINE or real-backend request');
   if (process.env.SOKUPA_SCREENSHOT_DIR && mode === 0 && !touch) {
    await h.height().fill('2.7'); await h.saved();
    const group = page.getByRole('group', { name: 'SYN-A の数量・リピート', exact: true });
    await group.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SOKUPA_SCREENSHOT_DIR + '/repeat-expanded-' + width + '.png' });
    await h.act(); await group.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SOKUPA_SCREENSHOT_DIR + '/repeat-collapsed-' + width + '.png' });
   }
   await h.context.close();
  }
  for (const [mode, base] of bases.entries()) for (const age of [DAY, DAY * 2]) {
   const h = await fixture(base, mode, 390);
   const before = await h.read();
   await h.act(); await h.act(); await h.saved();
   check((await h.read()).resultSession.meaningfulAt === before.resultSession.meaningfulAt, 'disclosure never renews retention time');
   await h.page.evaluate(value => localStorage.setItem('collapse-clock', String(value)), before.resultSession.meaningfulAt + age);
   await h.page.reload();
   await wait(() => h.read().then(value => value.parsed === null));
   check(age === DAY ? h.dialogs.length === 1 : h.dialogs.length === 0, '24h asks/48h resets display at unchanged saved boundary');
   check((await h.read()).resultSession.undo.parsed.items[0].order_quantity === before.parsed.items[0].order_quantity, 'one restore slot retains quantity through age policy');
   await ui.view(h.page, 'メモ画像');
   await h.page.getByRole('button', { name: '前回の結果だけ戻す', exact: true }).click();
   await ui.edit(h.page, 'SYN-A'); await h.saved();
   check(await h.toggle().getAttribute('aria-expanded') === 'true' && await h.height().isVisible(), 'explicit one-slot restore starts expanded without losing controls');
   check(h.errors.length === 0 && h.unexpected.length === 0, 'retention cases stay synthetic and error-free');
   await h.context.close();
  }
  console.log(JSON.stringify({ checks, normalAndBasic: true, widths: [320, 390], chromiumTouchEmulation: true, physicalIPhoneSafari: false, realAICalls: 0, realLineSends: 0, productionMutations: 0 }));
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

