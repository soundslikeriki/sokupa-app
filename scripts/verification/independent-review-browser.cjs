// Reproductions from independent review. Synthetic local fixtures; all external requests blocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ui = require('./result-workspace-helpers.cjs');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3317';
const key = 'sokupa:workspace:v1:synthetic-user';
const original = {product_code:'VS2067',manufacturer:'サンゲツ',entries:[{original_formula:'2.7×6',length_m:2.7,quantity:6,subtotal_m:16.2},{original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8}],total_m:20,order_quantity:23};
const draft = {version:1,siteName:'Synthetic',parsed:{items:[original]},originalParsed:{items:[original]},orderDraftItems:[]};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.SOKUPA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 let checks=0,uploads=0,jobs=0;
 const contextFor=async(raw)=>{
  const context=await browser.newContext({acceptDownloads:true});
 await ui.freshResultFixtures(context);
  await context.addInitScript(({key,raw})=>{if(!localStorage.getItem(key))localStorage.setItem(key,raw);},{key,raw});
  const page=await context.newPage();
  page.on('pageerror',error=>{throw error});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:'synthetic-user',keep_open_for_progress:true}});
   if(url.pathname==='/api/memo-images'){uploads++;return route.fulfill({json:{object_path:'synthetic-user/00000000-0000-4000-8000-000000000000.jpg'}});}
   if(url.pathname==='/api/analysis-jobs'){if(route.request().method()==='GET')return route.fulfill({json:{data:[]}});jobs++;return route.fulfill({json:{success:true,job_id:'00000000-0000-4000-8000-000000000000',execution_mode:'scheduled-wake',background_ready:true}});}
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{data:{status:'queued',total_images:1,done_images:0,can_resume:false,execution_mode:'scheduled-wake',background_ready:true}}});
   return route.continue();
  });
  await page.goto(base);return {context,page};
 };
 try{
  const {context,page}=await contextFor(JSON.stringify(draft));
  await ui.edit(page,'VS2067');
  assert.equal(await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).inputValue(),'23');checks++;
  assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].order_quantity,key),23);checks++;
  await page.getByTitle('タップして式を編集').first().click();
  await page.getByLabel('VS2067 1行目の幅数',{exact:true}).fill('-1');
  assert.equal(await page.getByLabel('VS2067 1行目の幅数',{exact:true}).inputValue(),'-1');checks++;
  await page.getByLabel('VS2067 1行目の長さ (m)',{exact:true}).fill('-1');
  assert.equal(await page.getByLabel('VS2067 1行目の長さ (m)',{exact:true}).inputValue(),'-1');checks++;
  assert.equal(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true}).isDisabled(),true);checks++;
  await page.reload();
  await ui.edit(page,'VS2067');
  assert.equal(await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).inputValue(),'23');checks++;
  await context.close();
  const broken=structuredClone(draft);broken.parsed.items[0].entries[0].quantity=-1;broken.parsed.items[0].entries[0].subtotal_m=-2.7;
  const raw=JSON.stringify(broken);
  const recovered=await contextFor(raw),p=recovered.page;
  await p.getByText('保存した下書きの復元が必要です',{exact:true}).waitFor();
  const png=await p.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;return canvas.toDataURL('image/png').split(',')[1];});
  await p.locator('input[type="file"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await p.getByAltText('プレビュー 1',{exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:'1枚の画像を解析する',exact:true}).isDisabled(),true);checks++;
  const downloadPromise=p.waitForEvent('download');
  await p.getByRole('button',{name:'保存データをダウンロード',exact:true}).click();
  const download=await downloadPromise;
  assert.equal(readFileSync(await download.path(),'utf8'),raw);checks++;
  await p.evaluate(()=>{window.realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.includes(':recovery:'))throw new DOMException('synthetic quota','QuotaExceededError');return window.realSet.call(this,key,value);};});
  await p.getByRole('button',{name:'元データを退避して新しく始める',exact:true}).click();
  await p.getByText(/元データを退避できませんでした/).waitFor();
  assert.equal(await p.evaluate(key=>localStorage.getItem(key),key),raw);checks++;
  await p.evaluate(()=>{Storage.prototype.setItem=window.realSet;});
  await p.getByRole('button',{name:'元データを退避して新しく始める',exact:true}).click();
  await p.waitForFunction(key=>Object.keys(localStorage).some(k=>k.startsWith(key+':recovery:')),key);
  assert.equal(await p.evaluate(key=>localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith(key+':recovery:'))),key),raw);checks++;
  await p.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed===null,key);
  assert.equal(await p.getByRole('button',{name:'1枚の画像を解析する',exact:true}).isEnabled(),true);checks++;
  await p.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();
  await p.waitForFunction(()=>document.body.innerText.includes('解析を受け付けました'));
  assert.equal(uploads,1);assert.equal(jobs,1);checks++;
  await p.getByText('サーバー側で解析を続けています。スマホを閉じても、完了後にLINEで通知します。').waitFor();checks++;
  assert.equal(await p.getByText('解析中はこの画面を開いたまま').count(),0);checks++;
  await recovered.context.close();
  console.log(`PASS: ${checks} independent-review browser checks; no external requests.`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
