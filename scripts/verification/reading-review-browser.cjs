const workspace = require('./result-workspace-helpers.cjs');
// Correction/cancellation review gate. Anonymous structured fixtures, synthetic private photos only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const full = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3323';
const basic = process.env.SOKUPA_BASIC_URL || 'http://127.0.0.1:3324';
for (const origin of [full, basic]) assert.equal(new URL(origin).hostname, '127.0.0.1');
const job = '00000000-0000-4000-8000-00000000000a';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; if (process.env.SOKUPA_TEST_PROGRESS) console.log(`PASS ${checks}: ${label}`); };
const until = async fn => { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Correction-review condition timed out'); };
const fixture = (mode, legacy, included) => {
  const warning = { product_code: 'REVIEW', manufacturer: 'Synthetic', needs_review: false, order_mode: mode,
    entries: [{ source_row_id: 'image-0:row-0', source_image_index: 0, source_entry_index: 0, original_formula: '2.4×2', length_m: 2.4, quantity: 2, subtotal_m: 4.8, repeat_enabled: mode === 'pattern' }], total_m: 4.8, order_quantity: 6,
    ...(legacy ? { notes: '訂正候補 1.5×3 を読み取りから除外しました。' } : { reading_reviews: [{ reason: '訂正候補 <b>原画像を照合</b> を計算から除外しました。', candidate_formulas: ['1.5×3'], source_image_index: 1 }] }),
    ...(mode === 'pattern' ? { measurement_basis: 'trim-included', pattern_match: 'straight', repeat_cm: 60 } : {}) };
  if (included) { warning.entries.push({ source_row_id: 'image-0:row-1', source_image_index: 0, source_entry_index: 1, original_formula: '1.5×3', length_m: 1.5, quantity: 3, subtotal_m: 4.5, repeat_enabled: false }); warning.total_m = 9.3; warning.order_quantity = 11; }
  const safe = { product_code: 'SAFE', manufacturer: 'Synthetic', entries: [{ original_formula: '2×1', length_m: 2, quantity: 1, subtotal_m: 2 }], total_m: 2, order_quantity: 3 };
  return { items: [warning, safe] };
};
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const errors = [];
  try {
    const scenarios = [
      { view: 'full', mode: 'memo' }, { view: 'full', mode: 'pattern' },
      { view: 'basic', mode: 'memo' }, { view: 'basic', mode: 'pattern' },
      { view: 'basic', mode: 'memo', legacy: true }, { view: 'full', mode: 'memo', included: true },
      { view: 'full', mode: 'memo', mixedGlobal: true }, { view: 'basic', mode: 'memo', globalNotesOnly: true },
    ];
    for (const scenario of scenarios) {
      const { view, mode, legacy = false, included = false, mixedGlobal = false, globalNotesOnly = false } = scenario;
      const base = view === 'basic' ? basic : full;
      const owner = `synthetic-reading-${view}-${mode}-${legacy}-${included}`, key = `sokupa:workspace:v1:${owner}`;
      const parsed = fixture(mode, legacy, included), photos = [];
      if (mixedGlobal || globalNotesOnly) {
        delete parsed.items[0].reading_reviews; delete parsed.items[0].notes;
        if (mixedGlobal) parsed.items[0].notes = '品番を書き直したため、原画像で確認してください。';
        parsed.notes = 'SAFEの3×4行は取消として除外しました。原画像で確認してください。';
      }
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 await workspace.freshResultFixtures(context);
      await context.addInitScript(({ key, parsed, job }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, siteName: 'Synthetic', parsed, originalParsed: parsed, orderDraftItems: [], resultJobId: job }));
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.copied.push(text) } });
      }, { key, parsed, job });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        if (url.pathname === '/api/auth/session') return route.fulfill({ json: { authenticated: true, line_user_id: owner } });
        if (url.pathname === '/api/analysis-jobs') return route.fulfill({ json: { data: [] } });
        if (url.pathname === `/api/analysis-jobs/${job}/seen`) return route.fulfill({ json: { success: true } });
        if (url.pathname === `/api/analysis-jobs/${job}`) return route.fulfill({ json: { data: { id: job, status: 'done', result: parsed, total_images: 2, done_images: 2, notification_status: 'accepted', background_ready: true, execution_mode: 'scheduled-wake' } } });
        if (url.pathname.startsWith(`/api/analysis-jobs/${job}/images/`)) { photos.push(Number(url.pathname.split('/').at(-1))); return route.fulfill({ contentType: 'image/png', body: png }); }
        if (url.pathname.startsWith('/api/')) throw Error('Unexpected synthetic API: ' + url.pathname);
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.dismiss());
      const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
      const item = async () => (await read()).parsed.items[0];
      const saved = () => until(() => page.getByLabel('結果の保存状態').innerText().then(text => text.includes('保存済み')));
      const review = () => page.getByLabel('REVIEW の訂正・取消を確認済みにする', { exact: true });
      const general = () => page.getByLabel(view === 'full' && mode === 'pattern' ? 'REVIEW の必要量の前提を確認済みにする' : 'REVIEW のメモと発注数量を確認済みにする', { exact: true });
      const copy = () => page.getByRole('button', { name: '発注用テキストをコピー', exact: true, includeHidden: true });
      const bulk = () => page.getByRole('button', { name: 'すべて発注リストへ追加（2品番）', exact: true, includeHidden: true });
      const region = () => page.getByRole('region', { name: 'REVIEW の訂正・取消の確認', exact: true, includeHidden: true });
      await page.goto(base); await workspace.edit(page, 'REVIEW'); await page.getByLabel('REVIEW の個別照合詳細',{exact:true}).locator(':scope > summary').click(); await review().waitFor(); await saved();
      for (const code of ['REVIEW','SAFE']) { await workspace.edit(page, code); const outer=page.getByLabel(`${code} の個別照合詳細`,{exact:true});if(await outer.count()&&await outer.getAttribute('open')===null)await outer.locator('summary').first().click(); const detail=page.locator(`details[aria-label="${code} の読み取り詳細"]`); if(await detail.count()) await detail.locator('summary').click(); }
      if (mixedGlobal || globalNotesOnly) {
        for (const code of ['REVIEW', 'SAFE']) { await workspace.edit(page, code);
          const warning = page.getByRole('region', { name: `${code} の訂正・取消の確認`, exact: true });
          check((await warning.innerText()).includes('3×4'), `${view}: global exclusion evidence reaches ${code}`);
          check(await page.getByLabel(`${code} のメモと発注数量を確認済みにする`, { exact: true }).isDisabled(), 'global warning requires a dedicated acknowledgement for each item');
        }
        if (mixedGlobal) check((await region().innerText()).includes('品番を書き直した') && !(await page.getByRole('region', { name: 'SAFE の訂正・取消の確認', exact: true, includeHidden: true }).innerText()).includes('品番を書き直した'), 'an unrelated local warning cannot hide or mis-scope the global exclusion');
        check(await copy().isDisabled() && await bulk().isDisabled(), 'global-only evidence blocks all calculated output');
        check((await item()).entries.length === 1 && (await item()).order_quantity === 6, 'a global candidate is not automatically added');
        await until(() => read().then(value => value.parsed.items.every(entry => entry.reading_reviews?.some(review => review.candidate_formulas.includes('3×4'))))); await saved();
        await page.reload(); await workspace.edit(page, 'REVIEW'); await page.getByLabel('REVIEW の個別照合詳細',{exact:true}).locator(':scope > summary').click(); await review().waitFor();
        check(await general().isDisabled() && await copy().isDisabled(), 'legacy global notes remain gated after normalization and reload');
        check((await read()).originalParsed.notes.includes('3×4'), 'original global notes remain unchanged');
        await context.close(); continue;
      }
      await workspace.edit(page, 'REVIEW');
      if (view === 'basic') await page.getByText('基本表示中です。', { exact: false }).waitFor();
      check(!(await region().getAttribute('class')).includes('bg-amber')&&await page.getByRole('button',{name:'REVIEW の確認画面を開く',exact:true}).isVisible(), `${view}/${mode}: short actionable review replaces the persistent amber frame`);
      check((await region().innerText()).includes('1.5×3'), 'candidate formula remains visible');
      if (!legacy) check(await region().locator('b').count() === 0 && (await region().innerText()).includes('<b>原画像を照合</b>'), 'OCR reason is escaped React text');
      check((await item()).entries.length === (included ? 2 : 1) && (await item()).total_m === (included ? 9.3 : 4.8), 'candidate is never automatically added, including an already-present row');
      await workspace.edit(page, 'SAFE'); await page.getByLabel('SAFE のメモと発注数量を確認済みにする', { exact: true }).check(); await workspace.edit(page, 'REVIEW');
      check(await general().isDisabled() && await copy().isDisabled() && await bulk().isDisabled(), 'general acknowledgement cannot authorize an unresolved correction');
      check(await page.getByRole('button', { name: '発注リストに追加', exact: true }).first().isDisabled(), 'individual transfer uses the same correction gate');
      await page.getByLabel('REVIEW の詳細を省略', { exact: true }).click();
      check(await page.getByRole('button', { name: '追加', exact: true }).isDisabled(), 'collapsed transfer remains blocked');
      await page.getByLabel('REVIEW の詳細を展開', { exact: true }).click();
      const individual=page.getByLabel('REVIEW の個別照合詳細',{exact:true});if(await individual.getAttribute('open')===null)await individual.locator(':scope > summary').click();
      const photoIndex = legacy ? 0 : 1;
      await page.getByRole('button', { name: `REVIEW の訂正候補の写真 ${photoIndex + 1}を確認`, exact: true }).click();
      await page.getByAltText(`解析元の写真 ${photoIndex + 1}`, { exact: true }).waitFor();
      check(photos.includes(photoIndex), 'candidate source index or entry-source fallback uses the private photo route');
      if (view === 'basic') check(await page.getByRole('button', { name: 'REVIEW 明細1の写真を確認', exact: true }).count() === 0, 'basic exposes only the necessary correction photo, not optional row-photo UI');
      await page.getByRole('button', { name: '数量に戻る', exact: true }).click();
      if (process.env.SOKUPA_REVIEW_SCREENSHOT && view === 'full' && mode === 'memo' && !included) await region().screenshot({ path: process.env.SOKUPA_REVIEW_SCREENSHOT });
      if (!included) {
        await page.getByLabel('REVIEW に追加する長さ (m)', { exact: true }).fill('1.5');
        await page.getByLabel('REVIEW に追加する幅数', { exact: true }).fill('3');
        await page.getByRole('button', { name: '幅数を追加', exact: true }).first().click();
        await until(() => item().then(value => value.entries.length === 2));
        check(!(await review().isChecked()) && await general().isDisabled() && await copy().isDisabled(), 'adding the candidate does not silently acknowledge either review');
        await page.getByTitle('タップして式を編集').nth(1).click();
        await page.getByLabel('REVIEW 2行目の幅数', { exact: true }).fill('4');
        await until(() => item().then(value => value.entries[1].quantity === 4 && value.order_quantity === 13));
        check((await item()).total_m === 10.8 && !(await review().isChecked()), 'user-corrected quantity is recalculated but still requires explicit source review');
      }
      await review().check();
      check(await general().isEnabled() && await copy().isDisabled() && await bulk().isDisabled(), 'dedicated review alone does not substitute for the general final-quantity acknowledgement');
      await general().check(); await until(() => item().then(value => Boolean(value.reading_review_confirmation && value.quantity_confirmation))); await saved();
      check(await copy().isEnabled() && await bulk().isEnabled(), 'both acknowledgements release all calculated output');
      const finalQuantity = included ? 11 : 13;
      await workspace.copy(page); check((await page.evaluate(() => window.copied.at(-1))).includes(`品番：REVIEW / 数量：${finalQuantity}m`), 'copy includes the reviewed corrected quantity exactly once');
      check((await item()).reading_reviews[0].candidate_formulas.includes('1.5×3'), 'candidate evidence is retained after confirmation');
      const snapshot = (await item()).reading_review_confirmation;
      await page.reload(); await workspace.edit(page, 'REVIEW'); await page.getByLabel('REVIEW の個別照合詳細',{exact:true}).locator(':scope > summary').click(); await review().waitFor(); await saved();
      check(await review().isChecked() && await general().isChecked() && await copy().isEnabled(), 'both acknowledgements restore after reload');
      check((await item()).reading_review_confirmation === snapshot && (await item()).reading_reviews.some(review => review.candidate_formulas.includes('1.5×3')), 'reload keeps the review fingerprint and candidate record');
      await page.locator('details[aria-label="REVIEW の読み取り詳細"]').locator('summary').click();
      check((await region().innerText()).includes('1.5×3'), 'preserved candidate is visible when the user expands its explanation');
      await page.getByRole('button', { name: '発注リストに追加', exact: true }).first().click();
      await until(() => read().then(value => value.orderDraftItems.length === 1));
      check((await read()).orderDraftItems[0].quantity === finalQuantity, 'individual draft transfer does not apply the candidate or reserve twice');
      await workspace.mode(page, 'メモ計測'); await workspace.edit(page); await workspace.view(page, '概要'); await bulk().click();
      await page.getByText('REVIEW はすでに発注リストにあります', { exact: true }).waitFor();
      await page.getByRole('button', { name: '別項目で追加', exact: true }).click();
      await until(() => read().then(value => value.orderDraftItems.length === 3));
      check((await read()).orderDraftItems.map(value => value.quantity).join(',') === `${finalQuantity},${finalQuantity},3`, 'bulk transfer uses the same reviewed final quantities');
      await workspace.mode(page, 'メモ計測'); await workspace.edit(page);
      await page.getByLabel('REVIEW の発注数量を入力', { exact: true }).fill(String(finalQuantity + 1));
      await until(() => item().then(value => value.reading_review_confirmation === '' && value.quantity_confirmation === '')); await saved();
      check(!(await review().isChecked()) && await general().isDisabled() && await copy().isDisabled() && await bulk().isDisabled(), 'later final-quantity edits invalidate both acknowledgements and every output gate');
      await review().check(); await general().check(); await until(() => item().then(value => Boolean(value.reading_review_confirmation && value.quantity_confirmation))); await saved();
      await page.getByTitle('この数式を削除').nth(1).click();
      await until(() => item().then(value => value.entries.length === 1 && !value.reading_review_confirmation));
      check(!(await review().isChecked()) && await copy().isDisabled() && (await region().innerText()).includes('1.5×3'), 'deleting the corrected row blocks output again without discarding candidate evidence');
      check((await read()).originalParsed.items[0].entries.length === (included ? 2 : 1), 'original parsed evidence is never mutated');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile review UI fits the viewport');
      await context.close();
    }
    check(errors.length === 0, 'no browser runtime errors: ' + errors.join('; '));
    console.log(JSON.stringify({ checks, fullMemoPattern: true, basicMemoPattern: true, legacyNotes: true, globalNotesRecovery: true, mixedGlobalScope: true, alreadyIncludedCandidate: true, realAiCalls: 0, realLineSends: 0, externalRequestsAllowed: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
