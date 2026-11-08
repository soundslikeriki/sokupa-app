const workspace = require('./result-workspace-helpers.cjs');
// Synthetic data only. No production keys/data; every non-local or unrecognised API request is blocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const bases = [process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:17737', process.env.SOKUPA_BASIC_URL || 'http://127.0.0.1:17738'];
for (const base of bases) assert.equal(new URL(base).hostname, '127.0.0.1');
const shared = '別の行の訂正を原画像で確認してください。' + '補足説明です。'.repeat(120);
const meters = [20,10,15,12,8,30], quantities = [23,12,18,14,10,35];
const item = (code, m=20) => ({product_code:code,manufacturer:'Synthetic',entries:[{original_formula:`${m}×1`,length_m:m,quantity:1,subtotal_m:m}],total_m:m,order_quantity:23});
let checks=0;const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log(`PASS ${checks}: ${label}`);};
const until=async fn=>{for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Synthetic UI condition timed out');};
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const errors=[],external=[];
 const fixture=async(base,width,parsed)=>{
  const owner=`synthetic-compact-${width}`,key=`sokupa:workspace:v1:${owner}`;
  const context=await browser.newContext({viewport:{width,height:844}});
 await workspace.freshResultFixtures(context);
  await context.addInitScript(({key,parsed})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed,originalParsed:parsed,orderDraftItems:[]}));window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>window.copied.push(t)}});},{key,parsed});
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!==base){external.push(u.origin);return route.abort();}
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
   if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
   if(u.pathname.startsWith('/api/'))throw Error(`Unexpected API ${u.pathname}`);
   return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());await page.goto(base);
  const saved=()=>until(()=>page.getByLabel('結果の保存状態').innerText().then(t=>t.includes('保存済み')));
  await page.getByLabel(`${parsed.items[0].product_code} の一覧発注数量`,{exact:true}).waitFor();await saved();
  return {context,page,saved,key,read:()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key)};
 };
 try{
  for(const base of bases)for(const width of [320,390]){
   const items=meters.map((m,n)=>({...item(`ANON${n+1}`,m),needs_review:true,review_reasons:[shared,shared],reading_reviews:[{reason:shared,candidate_formulas:['1×2'],source_image_index:0},{reason:shared,candidate_formulas:['1×2']}]}));
   const h=await fixture(base,width,{items,notes:shared,needs_review_any:true}),{page}=h;
   const copy=page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true});
   const explanation=page.locator('details[aria-label="読み取り・計算の説明"]');
   check(await explanation.getAttribute('open')===null,'general explanations closed by default');
   for(let n=0;n<6;n++)check(await page.getByLabel(`ANON${n+1} の一覧発注数量`,{exact:true}).innerText()===`${quantities[n]}m`,'all six quantities remain visible at top');
   const firstY=(await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).boundingBox()).y;
   check(firstY>0&&await page.locator('#material-ANON1').isHidden(),'quantity summary is immediate while product editors are hidden');
   check(await copy.isDisabled(),'unconfirmed output remains blocked');
   if(process.env.SOKUPA_SCREENSHOT_DIR){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await page.getByRole('heading',{name:'発注内容の確認',exact:true}).locator('..').locator('..').screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/initial-quantity-first-${base===bases[0]?'normal':'basic'}-${width}.png`});}
   await workspace.edit(page, 'ANON1'); await explanation.locator('summary').press('Enter');check(await explanation.getAttribute('open')!==null,'keyboard can expand warnings');
   check(await explanation.getByText(shared,{exact:false}).count()===1,'shared top warning is not repeated for each product');
   await explanation.locator('summary').press('Enter');check(await copy.isDisabled(),'hiding warnings cannot authorize copying');
   for(const product of items){ await workspace.edit(page, product.product_code);
    const code=product.product_code,d=page.locator(`details[aria-label="${code} の読み取り詳細"]`);
    check(await d.getAttribute('open')===null,'per-product lengthy reading evidence is collapsed');
    await d.locator('summary').click();check(await d.getByText(shared,{exact:true}).count()===1,'duplicate reason is shown once without removing evidence');await d.locator('summary').click();
    await page.getByLabel(`${code} の訂正・取消を確認済みにする`,{exact:true}).check();
    const ack=page.getByLabel(`${code} のメモと発注数量を確認済みにする`,{exact:true});await until(()=>ack.isEnabled());await ack.check();
   }
   await h.saved();check(await copy.isEnabled(),'all existing safety confirmations enable copying');await workspace.copy(page);const copied=await page.evaluate(()=>window.copied.at(-1));
   for(let n=0;n<6;n++)check(copied.includes(`ANON${n+1} / 数量：${quantities[n]}m`),'copy uses the final quantity without another allowance');
   await workspace.edit(page, 'ANON1'); const quantity=page.getByLabel('ANON1 の発注数量を入力',{exact:true});await quantity.fill('');await until(()=>h.read().then(d=>d.parsed.items[0].order_quantity_input==='')).catch(async error=>{console.log('SYNTHETIC_BLANK_DIAGNOSTIC',JSON.stringify({input:await quantity.inputValue(),item:(await h.read()).parsed.items[0]}));throw error;});await h.saved();
   check(await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).innerText()==='未確定'&&await copy.isDisabled(),'missing quantity is visibly unresolved and blocks output');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at narrow width');
   if(process.env.SOKUPA_SCREENSHOT_DIR){await workspace.view(page, '数量');fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});const card=page.getByRole('heading',{name:'発注内容の確認',exact:true}).locator('..').locator('..');await card.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/quantity-first-${base===bases[0]?'normal':'basic'}-${width}.png`});}
   await h.context.close();
  }
  const height={...item('HEIGHT'),measurement_basis:'trim-included',pattern_match:'straight',repeat_cm:60,loss_rate_percent:0,entries:[{source_row_id:'row0',original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4},{source_row_id:'row1',original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8}],total_m:9.2,order_quantity:10};
  const h=await fixture(bases[0],320,{items:[height]});const {page,read}=h;
  await until(()=>read().then(d=>d.parsed.items[0].total_m===9.2));check(true,'repeat OFF retains 9.2m');
  await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT 1行目のリピート計算',{exact:true}).click();await until(()=>read().then(d=>d.parsed.items[0].total_m===9.8));check(true,'only the first row ON gives 9.8m');
  await page.getByRole('switch',{name:'HEIGHT の一括リピート計算',exact:true}).click();await until(()=>read().then(d=>d.parsed.items[0].total_m===10.2));check(true,'all rows ON gives 10.2m');
  if(process.env.SOKUPA_SCREENSHOT_DIR)await page.locator('#material-HEIGHT').screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/expanded-repeat-master-and-rows.png`});
  await page.reload();await page.getByLabel('HEIGHT の一覧発注数量',{exact:true}).waitFor();await h.saved();const restored=(await read()).parsed.items[0];
  check(restored.total_m===10.2&&restored.entries[0].length_m===2.7&&restored.entries[1].length_m===3.8,'reload preserves distinct source heights and avoids double repeat');
  await workspace.edit(page, 'HEIGHT'); await page.getByRole('switch',{name:'HEIGHT の一括リピート計算',exact:true}).click();await until(()=>read().then(d=>d.parsed.items[0].total_m===9.2));check(true,'master OFF restores raw 9.2m');
  check(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true}).isDisabled(),'repeat changes never bypass confirmation');await h.context.close();
  const longCode='LONGCODE'+'X'.repeat(48),long=await fixture(bases[0],320,{items:[item(longCode)]});
  check((await long.page.getByLabel(`${longCode} の一覧発注数量`,{exact:true}).innerText())==='23m','long product code cannot hide the quantity');
  check(await long.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long product code fits narrow page without truncating the quantity');await long.context.close();
  check(errors.length===0,`no browser errors: ${errors.join(';')}`);check(external.length===0,'no non-local requests');console.log(`PASS ${checks} quantity-first browser checks`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
