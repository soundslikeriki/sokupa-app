// Synthetic browser fixtures only. Blocks every non-localhost request.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3317';
const id = 'synthetic-user';
const key = `sokupa:workspace:v1:${id}`;
const original = { product_code:'VS2067', manufacturer:'サンゲツ', spec:'巾92cm', entries:[{original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4}], total_m:5.4, order_quantity:7 };
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.SOKUPA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 let checks=0;
 try {
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==base) return route.abort();
  if(url.pathname==='/api/auth/session') return route.fulfill({json:{authenticated:true,line_user_id:id,display_name:'Synthetic'}});
  if(url.pathname.startsWith('/api/')) return route.fulfill({json:{data:null}});
  return route.continue();
 });
 await context.addInitScript(({key,original})=>{
   if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic site',parsed:{items:[original]},originalParsed:{items:[original]},orderDraftItems:[]}));
 },{key,original});
 await page.goto(base);
 await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();
 // Toggle repeat from the original measured length.
 const repeat=page.getByLabel('VS2067 のリピート (cm)',{exact:true});
 await repeat.fill('60');
 await page.getByRole('switch',{name:'VS2067 の一括リピート計算'}).click();
 await page.waitForFunction(key=>{const d=JSON.parse(localStorage.getItem(key));return d.parsed.items[0].total_m===6&&d.parsed.items[0].entries[0].length_m===2.7;},key);
 checks++;
 await page.reload();
 await page.getByRole('switch',{name:'VS2067 の一括リピート計算'}).waitFor();
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].total_m===6,key);
 assert.equal(await repeat.inputValue(),'60');checks++;
 await page.getByRole('switch',{name:'VS2067 の一括リピート計算'}).click();
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].total_m===5.4,key);checks++;
 await page.getByTitle('タップして式を編集').click();
 await page.getByLabel('VS2067 1行目の幅数',{exact:true}).fill('3');
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].entries[0].quantity===3,key);checks++;
 await page.reload();
 await page.getByRole('button',{name:'↺ 解析結果に戻す'}).click();
 await page.waitForFunction(key=>{const d=JSON.parse(localStorage.getItem(key));return d.parsed.items[0].entries[0].quantity===2&&d.parsed.items[0].total_m===5.4;},key);checks++;
 await page.getByRole('button',{name:'発注リストに追加',exact:true}).click();
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).orderDraftItems.length===1,key);
 await page.reload();
 await page.getByRole('tab',{name:/発注リスト/}).click();
 assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).orderDraftItems.length,key),1);checks++;
 // Screenshot has synthetic data only.
 if(process.env.SOKUPA_SCREENSHOT)await page.screenshot({path:process.env.SOKUPA_SCREENSHOT,fullPage:true});
 await page.getByRole('tab',{name:/寸法から計算/}).click();
 await page.locator('input[type="file"]').setInputFiles({name:'synthetic-broken.jpg',mimeType:'image/jpeg',buffer:Buffer.from('invalid synthetic image')});
 await page.getByText(/画像の読み込み・変換に失敗しました/).waitFor();checks++;
 assert.deepEqual(errors,[]);checks++;
 await context.close();
 const loggedOut=await browser.newPage();
 await loggedOut.route('**/*',async route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await loggedOut.goto(base);
 await loggedOut.getByRole('link',{name:'登録済みの方・管理者はLINEでログイン'}).waitFor();checks++;
 console.log(`PASS: ${checks} browser regressions; synthetic fixtures only; no external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
