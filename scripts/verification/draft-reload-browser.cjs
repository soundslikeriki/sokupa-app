const workspace = require('./result-workspace-helpers.cjs');
// Current and legacy drafts; notifications may still be pending when the page is reloaded.
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317',user='synthetic-user',id='00000000-0000-4000-8000-000000000009',key=`sokupa:workspace:v1:${user}`,pointer=`sokupa:lastJobId:${user}`;
const item={product_code:'VS2067',manufacturer:'Synthetic',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 try{for(const legacy of [false,true])for(const after of ['failed','accepted']){
  let notification='failed',seen=0;
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>{throw e;});
 await workspace.freshResultFixtures(context);
  await context.addInitScript(({pointer,id})=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem(pointer,id);sessionStorage.setItem('seeded','true');}},{pointer,id});
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user}});
   if(url.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:[{id,status:'done'}]}});
   if(url.pathname===`/api/analysis-jobs/${id}`)return route.fulfill({json:{data:{id,status:'done',total_images:1,done_images:1,result:{items:[item]},notification_status:notification,can_resume:notification==='failed',execution_mode:'scheduled-wake',background_ready:true}}});
   if(url.pathname===`/api/analysis-jobs/${id}/seen`){seen++;return route.fulfill({json:{success:true}});}
   if(url.pathname===`/api/analysis-jobs/${id}/resume`)return route.fulfill({status:202,json:{success:true}});
   if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);return route.continue();
  });
  await page.goto(base);await workspace.edit(page,'VS2067');await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();
  await page.getByTitle('タップして式を編集').click();await page.getByLabel('VS2067 1行目の幅数',{exact:true}).fill('2');
  await page.waitForFunction(({key,id})=>{const d=JSON.parse(localStorage.getItem(key));return d.resultJobId===id&&d.parsed.items[0].order_quantity===46;},{key,id});checks++;
  if(legacy)await page.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key));delete d.resultJobId;localStorage.setItem(key,JSON.stringify(d));},key);
  notification=after;await page.reload();await workspace.edit(page,'VS2067');await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();
  if(legacy){
    await page.getByText('別の解析結果があります',{exact:true}).waitFor();
    const d=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);assert.equal(d.resultJobId,null);assert.equal(d.parsed.items[0].order_quantity,46);
    await page.getByRole('button',{name:'今の下書きを続ける',exact:true}).click();
  }else await page.waitForFunction(({key,id})=>{const d=JSON.parse(localStorage.getItem(key));return d.resultJobId===id&&d.parsed.items[0].order_quantity===46;},{key,id});checks++;
  await page.waitForTimeout(3300);assert.equal(await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).inputValue(),'46');checks++;
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);assert.equal(saved.parsed.items[0].entries[0].quantity,2);assert.equal(saved.originalParsed.items[0].entries[0].quantity,1);assert.ok(seen>=1);checks++;
  await context.close();
 }
 console.log(`PASS: ${checks} draft reload checks; current/legacy metadata and failed/accepted notifications; no external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
