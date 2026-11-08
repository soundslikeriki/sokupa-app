// Presentation-only assertions against real local builds; all API responses/data are synthetic.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ui = require('./result-workspace-helpers.cjs');
const bases = [process.env.SOKUPA_TEST_URL, process.env.SOKUPA_BASIC_URL];
for (const base of bases) assert.equal(new URL(base).hostname, '127.0.0.1');
const owner = 'synthetic-repeat-controls', key = `sokupa:workspace:v1:${owner}`, code = 'SYN';
const seed = { product_code: code, manufacturer: 'Synthetic', measurement_basis: 'trim-included', pattern_match: 'straight',
  repeat_cm: 64, order_mode: 'pattern', pattern_rows_configured: true, loss_rate_percent: 15,
  entries: [{ source_row_id: 'a', original_formula: '2.7×2', length_m: 2.7, quantity: 2, subtotal_m: 5.4, repeat_enabled: true },
    { source_row_id: 'b', original_formula: '0.8×6', length_m: 0.8, quantity: 6, subtotal_m: 4.8, repeat_enabled: true }], total_m: 14.08, order_quantity: 17 };
let checks = 0;
const check = (value,label) => { assert.ok(value,label); console.log(`PASS ${++checks}: ${label}`); };
const until = async fn => { for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Repeat control condition timed out'); };
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {for(const [mode,base] of bases.entries())for(const width of [390,320]) {
  const fixture=async item=>{
   const context=await browser.newContext({viewport:{width,height:844}}),errors=[];
 await ui.freshResultFixtures(context);
   await context.addInitScript(({key,item})=>{
    if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed:{items:[item]},originalParsed:{items:[item]},orderDraftItems:[]}));
    window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.copied.push(value)}});
   },{key,item});
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
    if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
    if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
    if(u.pathname.startsWith('/api/')){errors.push('Unexpected API '+u.pathname);return route.abort();}return route.continue();
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await ui.edit(page);
   const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
   const saved=async()=>{
    await until(()=>page.getByLabel('結果の保存状態').innerText().then(s=>s.includes('保存済み')));
    // Do not confuse an earlier saved-status render with the update just queued by an input.
    let previous='',stable=0;
    await until(async()=>{
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
     const current=await page.evaluate(()=>JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))));
     stable=current===previous?stable+1:0;previous=current;
     return stable>=3&&(await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');
    });
   };
   await saved();
   const details=()=>page.getByLabel(`${code} のリピート詳細設定`,{exact:true});
   const ack=()=>page.getByLabel(`${code} の${mode?'メモと発注数量':'必要量の前提'}を確認済みにする`,{exact:true});
   const copy=()=>page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true});
   const snapshot=()=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])));
   const neutralDisclosure=async()=>{
    await saved();const before=await snapshot();
    await ui.repeatSettings(page,code);await details().locator('summary').click();
    const calc=page.getByLabel(`${code} の計算説明`,{exact:true});await calc.locator('summary').click();await calc.locator('summary').click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    check(JSON.stringify(await snapshot())===JSON.stringify(before),'opening/closing details preserves all stored bytes, quantities, manual values and fingerprints');
   };
   const finish=async()=>{check(errors.length===0,'no browser or unapproved API error');await context.close();};
   return {context,page,read,saved,details,ack,copy,neutralDisclosure,finish};
  };
  {
   const h=await fixture(seed),{page}=h;
   check(await h.details().getAttribute('open')===null&&await page.getByLabel('SYN の壁の高さ (m)',{exact:true}).isVisible(),'common height remains directly editable while conditions start closed');
   check(await page.getByLabel('SYN のリピート (cm)',{exact:true}).isVisible()&&await page.getByLabel('SYN の一括リピート計算',{exact:true}).isVisible(),'repeat cm and master toggle are immediate controls');
   check((await page.getByLabel('SYN の高さの適用状態',{exact:true}).innerText())==='各行の寸法で計算','row-based default is explicit');
   check((await page.getByTitle('タップして式を編集').first().innerText()).includes('2.7→3.2m'),'input length and repeat result are distinguished briefly');
   if(process.env.SOKUPA_SCREENSHOT_DIR&&!mode&&width===390){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/repeat-normal-390-initial.png`,fullPage:true});}
   await page.getByLabel('SYN の発注数量を入力',{exact:true}).fill('20');await until(()=>h.read().then(d=>d.parsed.items[0].manual_order_quantity===20));check(await h.ack().count()===0,'quantity acknowledgement control is removed');await h.saved();
   check(await h.copy().isEnabled(),'valid manual amount is usable without a quantity confirmation');
   await h.neutralDisclosure();check(await h.copy().isEnabled()&&(await h.read()).parsed.items[0].manual_order_quantity===20,'disclosure leaves confirmed manual quantity usable');
   if(process.env.SOKUPA_SCREENSHOT_DIR&&width===(mode?320:390)){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/repeat-${mode?'basic':'normal'}-${width}-closed.png`,fullPage:true});}
   await page.getByLabel('SYN のリピート条件を確認',{exact:true}).click();check(await h.details().getAttribute('open')!==null&&await h.details().locator('summary').evaluate(e=>e===document.activeElement),'shortcut opens and focuses actual available controls');
   check(await page.getByLabel('SYN の寸法区分',{exact:true}).isVisible()&&await page.getByLabel('SYN の柄合わせ方式',{exact:true}).isVisible(),'both interfaces can reach required condition controls');
   if(process.env.SOKUPA_SCREENSHOT_DIR&&!mode&&width===390)await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/repeat-normal-390-open.png`,fullPage:true});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'closed/open layout fits narrow viewport');
   await ui.copy(page);check((await page.evaluate(()=>window.copied.at(-1))).includes('数量：20m'),'copy preserves final manual amount without another reserve');
   await page.getByRole('button',{name:'発注リストに追加',exact:true}).first().click();await until(()=>h.read().then(d=>d.orderDraftItems.length===1));check((await h.read()).orderDraftItems[0].quantity===20,'order draft preserves confirmed amount');
   await h.finish();
  }
  {
   const h=await fixture({...seed,measurement_basis:'unconfirmed',pattern_match:'unconfirmed'}),{page}=h;
   check(await h.details().getAttribute('open')===null&&await h.copy().isEnabled()&&await h.ack().count()===0,'closed conditions remain unconfirmed without forbidding positive output');
   check((await page.getByLabel('SYN のリピート条件を確認',{exact:true}).innerText()).includes('リピート条件を確認'),'condition blocker has a visible short reason');
   await h.neutralDisclosure();await page.getByLabel('SYN のリピート条件を確認',{exact:true}).click();await page.getByLabel('SYN の寸法区分',{exact:true}).selectOption('trim-included');await page.getByLabel('SYN の柄合わせ方式',{exact:true}).selectOption('straight');
   check(await h.ack().count()===0&&await h.copy().isEnabled(),'explicit valid condition selection is sufficient; no quantity confirmation is added');await h.finish();
  }
  for(const state of ['off','invalid-off','all-individual','mixed','invalid','reading','blank']) {
   const item=structuredClone(seed);item.repeat_height_m=2.7;
   if(state==='off'||state==='invalid-off'){item.order_mode='memo';item.entries.forEach(e=>e.repeat_enabled=false);}
   if(state==='all-individual')item.entries.forEach(e=>e.repeat_use_row_length=true);
   if(state==='mixed')item.entries[1].repeat_use_row_length=true;
   if(state==='invalid'||state==='invalid-off')item.repeat_height_input='-1';
   if(state==='reading')item.reading_reviews=[{reason:'Synthetic correction',candidate_formulas:['0.8×6']}];
   if(state==='blank')item.entries[1].length_input='';
   const h=await fixture(item),{page}=h;const status=await page.getByLabel('SYN の高さの適用状態',{exact:true}).innerText();
   if(state==='off')check(status.includes('リピートOFF')&&!status.includes('を使用'),'saved common height is not called active while OFF');
   else if(state==='invalid-off') {
    const ack=page.getByLabel('SYN のメモと発注数量を確認済みにする',{exact:true});
    check(status.includes('入力を確認')&&status.includes('リピートOFF・未使用')&&await ack.count()===0,'unused invalid common setting is accurately labelled and does not block valid OFF quantities');
    await h.saved();check(await h.copy().isEnabled(),'valid OFF source quantity is usable without a quantity acknowledgement');
   }
   else {
    check(await h.details().getAttribute('open')===null,'saved settings do not automatically expand or convert drafts');
    await h.neutralDisclosure();
    if(state==='all-individual')check(status.includes('各行の個別寸法')&&status.includes('未使用'),'all individual rows do not claim shared height is applied');
    if(state==='mixed')check(status.includes('共通高さ 2.7m')&&status.includes('個別寸法1行を優先'),'mixed height policy is visible while closed');
    if(state==='invalid'){check(status.includes('入力を確認')&&await h.copy().isEnabled(),'invalid hidden common input has visible advisory');await page.getByLabel('SYN のリピート条件を確認',{exact:true}).click();check(await page.getByLabel('SYN の壁の高さ (m)',{exact:true}).inputValue()==='-1','invalid input remains reachable and unchanged');}
    if(state==='reading')check(await page.getByRole('button',{name:'SYN の確認画面を開く',exact:true}).isVisible()&&await page.getByLabel('SYN の訂正・取消を確認済みにする',{exact:true}).isHidden()&&!(await page.getByLabel('SYN の訂正・取消を確認済みにする',{exact:true}).isChecked())&&await h.copy().isEnabled()&&(await page.getByLabel('SYN のリピート条件を確認',{exact:true}).innerText()).includes('訂正・取消を確認'),'short OCR review entry stays visible while optional long controls are closed and positive output stays available without recording a confirmation');
    if(state==='blank')check(await page.getByText('未入力',{exact:true}).isVisible()&&await h.copy().isEnabled()&&(await page.getByLabel('SYN のリピート条件を確認',{exact:true}).innerText()).includes('入力未完了'),'unfinished row stays visible while the positive chosen quantity stays exportable');
   }
   check((await h.read()).parsed.items[0].repeat_height_m===2.7,'existing common-height value is never silently cleared');await h.finish();
  }
 }}finally{await browser.close();}
 console.log(JSON.stringify({checks,synthetic:true,widths:[320,390],normalAndBasic:true,realAiCalls:0,realLineSends:0,productionMutations:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
