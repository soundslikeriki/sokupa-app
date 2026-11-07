// Public UI paths, shared by synthetic browser suites after result navigation changed.
const view = async (page, name) => { await page.getByRole('tab', { name, exact: true }).click(); };
const edit = async (page, code) => { if (code) await page.getByLabel(`${code} の一覧発注数量`, { exact: true }).waitFor({ state: 'attached' }); await view(page, '編集・リピート'); if (code) await page.getByLabel('編集する品番', { exact: true }).selectOption(code); };
const mode = async (page, name) => { await page.getByRole('button', { name: '計測・発注メニュー', exact: true }).click(); await page.getByRole('group', { name: '既存機能へ切り替え' }).getByRole('button', { name: new RegExp(name) }).click(); };
const disclosure = async (page, text) => { const summary = page.locator('summary').filter({ hasText: text }).first(); if (await summary.locator('..').getAttribute('open') === null) await summary.click(); };
const copy = async page => { await view(page, '数量'); await page.getByRole('button', { name: '発注用テキストをコピー', exact: true }).click(); await edit(page); };
module.exports = { view, edit, mode, disclosure, copy };
