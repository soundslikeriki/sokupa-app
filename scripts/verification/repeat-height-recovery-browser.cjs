// Synthetic local-only regression: explicit row height must survive common-height recovery.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const ui = require('./result-workspace-helpers.cjs');
const bases = [process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:17746', process.env.SOKUPA_BASIC_TEST_URL].filter(Boolean);
for (const base of bases) assert.equal(new URL(base).hostname, '127.0.0.1');
const owner = 'synthetic-row-height', key = `sokupa:workspace:v1:${owner}`, code = 'SYN-HEIGHT';
const seed = { product_code: code, manufacturer: 'Synthetic', order_mode: 'pattern', pattern_rows_configured: true,
  repeat_cm: 60, repeat_height_m: 3.8, loss_rate_percent: 15, measurement_basis: 'trim-included', pattern_match: 'straight',
  entries: [{ source_row_id: 'long', original_formula: '3.8×1', length_m: 3.8, quantity: 1, subtotal_m: 3.8, repeat_enabled: true },
    { source_row_id: 'short', original_formula: '0.7×2', length_m: 0.7, quantity: 2, subtotal_m: 1.4, repeat_enabled: true }], total_m: 12.6, order_quantity: 15 };
let checks = 0;
const check = (value, label) => { assert.ok(value, label); console.log(`PASS ${++checks}: ${label}`); };
const until = async fn => { for (let i=0;i<200;i++) { if(await fn()) return; await new Promise(resolve=>setTimeout(resolve,50)); } throw Error('Condition timed out'); };
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {for (const base of bases) {
  const context=await browser.newContext({viewport:{width:390,height:844}}), errors=[];
 await ui.freshResultFixtures(context);
  await context.addInitScript(({key,seed})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed:{items:[seed]},originalParsed:{items:[seed]},orderDraftItems:[]}));},{key,seed});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
   if(url.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
   if(url.pathname.startsWith('/api/')){errors.push('Unexpected API '+url.pathname);return route.abort();}
   return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const item=async()=>(await read()).parsed.items[0];
  const saved=()=>until(()=>page.getByLabel('結果の保存状態').innerText().then(x=>x.includes('保存済み')));
  const height=()=>page.getByLabel(`${code} の壁の高さ (m)`,{exact:true});
  const toggle=index=>page.getByLabel(`${code} ${index}行目のリピート計算`,{exact:true});
  const master=()=>page.getByLabel(`${code} の一括リピート計算`,{exact:true});
  const copy=()=>page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true});
  const observe=async(total,order,label)=>{
   await until(async()=>{const i=await item();return i.total_m===total&&i.order_quantity===order;});
   check(await page.getByLabel(`${code} の発注数量を入力`,{exact:true}).inputValue()===String(order),label);
   await saved();
  };
  const reload=async()=>{await saved();await page.reload();await ui.edit(page);await ui.repeatSettings(page,code);};
  const editRow=async(index,value)=>{
   const field=page.getByLabel(`${code} ${index}行目の長さ (m)`,{exact:true});
   if(!(await field.isVisible()))await page.locator('[data-preserve-editor-input]').nth(index-1).getByTitle('タップして式を編集',{exact:true}).click();
   await field.fill(value);return field;
  };
  await page.goto(base);await ui.edit(page);await ui.repeatSettings(page,code);await observe(12.6,15,'legacy common-height draft remains unchanged');
  await editRow(2,'0.71');await editRow(2,'0.7');await observe(6.6,8,'explicit short height wins before reload');
  check((await item()).entries[1].repeat_use_row_length===true,'explicit precedence is persisted');
  check((await item()).entries[0].repeat_use_row_length!==true,'untouched row retains common-height behavior');
  await reload();await observe(6.6,8,'explicit precedence survives reload');
  check((await item()).entries[1].length_m===0.7&&(await item()).repeat_height_m===3.8,'raw short dimension and common setting both retained');
  await height().fill('5.1');await observe(7.8,9,'common height changes untouched row only');
  await reload();await observe(7.8,9,'new common and row priority survive reload');
  await height().fill('');await observe(6.6,8,'empty common uses every source row');
  await reload();await observe(6.6,8,'empty common survives reload');
  await height().fill('3.8');await observe(6.6,8,'restoring common does not erase explicit priority');
  await toggle(2).click();await observe(5.6,7,'individual OFF uses raw short dimension');
  await toggle(2).click();await observe(6.6,8,'individual ON restores per-row repeat');
  await master().click();await observe(5.2,6,'all OFF uses source dimensions');
  await master().click();await observe(6.6,8,'all ON keeps explicit row priority');
  await reload();await observe(6.6,8,'all-ON recovery keeps distinct source dimensions');
  await editRow(2,'');await until(async()=>(await item()).entries[1].length_input==='');await saved();check((await item()).entries[1].length_input===''&&await copy().isDisabled(),'blank row is saved and blocks output');
  await reload();check((await item()).entries[1].length_input===''&&await copy().isDisabled(),'blank recovery remains blocked');
  await editRow(2,'-1');await until(async()=>(await item()).entries[1].length_input==='-1');await saved();check((await item()).entries[1].length_input==='-1'&&await copy().isDisabled(),'invalid row is retained and blocks output');
  await reload();check((await item()).entries[1].length_input==='-1','invalid row survives reload');
  await editRow(2,'0.7');await observe(6.6,8,'valid completion restores saved row priority');
  await height().fill('-1');await until(async()=>(await item()).repeat_height_input==='-1');await saved();check(await copy().isDisabled(),'invalid common height blocks output without losing row priority');
  await reload();check(await height().inputValue()==='-1'&&(await item()).entries[1].repeat_use_row_length===true,'invalid common height and explicit row survive reload');
  await height().fill('3.8');await observe(6.6,8,'valid common height restores supported calculation');
  await ui.view(page,'数量');await ui.edit(page);await ui.mode(page,'実寸計測');await ui.mode(page,'メモ計測');await ui.edit(page);
  await observe(6.6,8,'tabs and modes preserve per-row height');
  // Row reset is also an explicit selection of that row's original dimensions.
  await editRow(2,'1.3');await observe(7.8,9,'new individual dimension is used');
  await page.getByTitle('この行の編集を元に戻す',{exact:true}).click();await observe(6.6,8,'row reset uses the correct source row');
  await reload();await observe(6.6,8,'row reset priority survives reload');
  if(!(await page.getByText('基本表示中です。解析・編集・保存・発注の基本機能を使えます。数量は元メモと照合してください。',{exact:true}).count())) {
   const ack=page.getByLabel(`${code} の必要量の前提を確認済みにする`,{exact:true});
   await ack.check();await saved();check(await copy().isEnabled(),'valid explicit quantities can be confirmed');
   await reload();check(await copy().isEnabled(),'same row calculation retains valid confirmation on reload');
   await height().fill('5.1');await observe(7.8,9,'changed common quantity recomputes');check(await copy().isDisabled(),'changed assumptions invalidate confirmation');
   await height().fill('3.8');await observe(6.6,8,'restored common keeps row priority after confirmation invalidation');
  }
  await page.getByRole('button',{name:'↺ 解析結果に戻す',exact:true}).click();await observe(12.6,15,'product reset restores original shared-height choices');
  check((await item()).entries.every(e=>e.repeat_use_row_length!==true),'product reset removes explicit row priority');
  await page.getByLabel(`${code} に追加する長さ (m)`,{exact:true}).fill('1.1');await page.getByLabel(`${code} に追加する幅数`,{exact:true}).fill('2');
  await page.getByRole('button',{name:'幅数を追加',exact:false}).click();await observe(14.8,18,'new row retains existing OFF default');
  await toggle(3).click();await observe(21,25,'new row can still use common height');
  await editRow(3,'1.11');await editRow(3,'1.1');await observe(15,18,'new row accepts explicit height');
  await page.getByLabel('この数式を削除',{exact:true}).first().click();await observe(10.8,13,'delete shifts explicit row identity correctly');
  await reload();await observe(10.8,13,'added/deleted row priority survives recovery');
  check((await item()).entries[1].length_m===1.1&&(await item()).entries[1].repeat_use_row_length===true,'explicit flag stays with surviving row');
  // A competing primary snapshot must be preserved instead of overwritten.
  await page.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key));d.siteName='Synthetic competing edit';localStorage.setItem(key,JSON.stringify(d));},key);
  await editRow(2,'1.2');await page.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).waitFor();
  check((await read()).siteName==='Synthetic competing edit'&&(await item()).entries[1].length_m===1.1,'save conflict preserves competing committed row');
  check(await page.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).isVisible(),'unsaved explicit edit has recovery action');
  check(errors.length===0,'no browser error or unapproved API');await context.close();
 }}finally{await browser.close();}
 console.log(`PASS: ${checks} row-height recovery checks; ${bases.length} local builds; no external requests.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
