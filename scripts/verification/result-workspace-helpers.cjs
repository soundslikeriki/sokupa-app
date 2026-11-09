// Public UI paths, shared by synthetic browser suites after result navigation changed.
const view = async (page, name) => { await page.getByRole('tab', { name, exact: true }).click(); };
const edit = async (page, code) => { if (code) await page.getByLabel(`${code} の一覧発注数量`, { exact: true }).first().waitFor({ state: 'attached' }); await view(page, '数量'); if (code) await page.getByLabel('編集する品番', { exact: true }).selectOption(code); };
const mode = async (page, name) => { await page.getByRole('button', { name: '計測・発注メニュー', exact: true }).click(); await page.getByRole('group', { name: '既存機能へ切り替え' }).getByRole('button', { name: new RegExp(name) }).click(); };
const disclosure = async (page, text) => { const summary = page.locator('summary').filter({ hasText: text }).first(); if(await summary.isHidden()&&await page.getByRole('tab',{name:'概要',exact:true}).isVisible())await view(page,'概要'); if (await summary.locator('..').getAttribute('open') === null) await summary.click(); };
const repeatSettings = async (page, code) => { const details = page.getByLabel(`${code} のリピート詳細設定`, { exact: true }); if (await details.getAttribute('open') === null) await details.locator('summary').click(); };
const copy = async page => { await view(page, '概要'); await page.getByRole('button', { name: '確認してコピー', exact: true }).click(); const dialog=page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true}); await dialog.getByRole('button', { name: '発注用テキストをコピー', exact: true }).click(); await dialog.getByRole('button',{name:'戻る',exact:true}).click(); await dialog.waitFor({state:'hidden'}); await edit(page); };
// Existing calculation/navigation suites seed current, freshly saved results. Time-policy
// suites do not use this helper and exercise the legacy/unknown-time path explicitly.
const freshResultFixtures = async context => context.addInitScript(() => {
 if(location.hostname!=='127.0.0.1')throw Error('Synthetic result fixture requires localhost');
 const original=Storage.prototype.setItem;
 Storage.prototype.setItem=function(key,value){
  if(key.startsWith('sokupa:workspace:v1:')&&!key.includes(':recovery:'))try{
   const draft=JSON.parse(value),items=draft.parsed?.items;
   if(draft.version===1&&!draft.resultSession&&Array.isArray(items)&&items.length&&items.every(i=>i.total_m>=0&&i.order_quantity>=0&&i.entries.every(e=>e.length_m>=0&&e.quantity>=0&&e.subtotal_m>=0))){
    const now=Date.now();draft.resultSiteName=draft.resultSiteName??draft.siteName;draft.resultSession={version:1,generation:0,inactive:false,fingerprint:'',meaningfulAt:now,observedAt:now,allowedJobId:null,undo:null};value=JSON.stringify(draft);
   }
  }catch{}
  return original.call(this,key,value);
 };
});
module.exports = { view, edit, mode, disclosure, repeatSettings, copy, freshResultFixtures };

// New one-slot snapshots live atomically inside the active value; old recovery records remain separate.
const recoveryDrafts = async (page, key) => page.evaluate(key => {
 const records=Object.keys(localStorage).filter(k=>k.startsWith(key+':recovery:')).map(k=>{const raw=localStorage.getItem(k);let draft=null;try{draft=JSON.parse(raw);}catch{}return{key:k,raw,draft};});
 const active=JSON.parse(localStorage.getItem(key));if(active?.recentDraft)records.unshift({key:key+':recent:'+active.recentDraft.revision,raw:active.recentDraft.raw,draft:JSON.parse(active.recentDraft.raw)});return records;
},key);
module.exports.recoveryDrafts = recoveryDrafts;
