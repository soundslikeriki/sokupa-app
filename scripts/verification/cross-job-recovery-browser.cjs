const workspace = require('./result-workspace-helpers.cjs');
// Two devices' result identities; synthetic API only and all external traffic blocked.
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317',user='synthetic-user',a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b',key=`sokupa:workspace:v1:${user}`;
const item=(m,q,order)=>({product_code:'VS2067',manufacturer:'Synthetic',entries:[{original_formula:`${m}×1`,length_m:m,quantity:q,subtotal_m:m*q}],total_m:m*q,order_quantity:order});
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 try{for(const scenario of ['different-job','legacy-identical-ocr','primary-write-failure','new-image-archive-failure']){
  const legacy=scenario==='legacy-identical-ocr',old={version:1,siteName:'Edited site A',parsed:{items:[item(20,2,46)]},originalParsed:{items:[item(20,1,23)]},orderDraftItems:[{id:'manual-A',productCode:'A-order',quantity:9,unit:'m',sourceType:'manual',sourceLabel:'A list'}],...(legacy?{}:{resultJobId:a})};
  const result={items:[item(legacy?20:10,1,legacy?23:12)]};let seenB=false,seenBCalls=0,submitted=scenario!=='new-image-archive-failure';
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:375,height:812}}),page=await context.newPage();page.on('pageerror',e=>{throw e;});
 await workspace.freshResultFixtures(context);
  await context.addInitScript(({key,old})=>{if(!sessionStorage.getItem('seeded')){localStorage.clear();localStorage.setItem(key,JSON.stringify(old));sessionStorage.setItem('seeded','yes');}},{key,old});
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user}});
   if(url.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:seenB||!submitted?[]:[{id:b,status:'done'}]}});
   if(url.pathname==='/api/memo-images')return route.fulfill({json:{object_path:user+'/00000000-0000-4000-8000-000000000002.jpg'}});
   if(url.pathname==='/api/analysis-jobs'){submitted=true;return route.fulfill({json:{success:true,job_id:b,execution_mode:'scheduled-wake',background_ready:true}});}
   if(url.pathname===`/api/analysis-jobs/${b}`)return route.fulfill({json:{data:{id:b,status:'done',site_name:'Server site B',total_images:1,done_images:1,result,notification_status:'accepted',can_resume:false,execution_mode:'scheduled-wake',background_ready:false}}});
   if(url.pathname===`/api/analysis-jobs/${a}/seen`)return route.fulfill({json:{success:true}});
   if(url.pathname===`/api/analysis-jobs/${b}/seen`){seenB=true;seenBCalls++;return route.fulfill({json:{success:true}});}
   if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);return route.continue();
  });
  const current=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const archived=()=>page.evaluate(key=>Object.keys(localStorage).filter(k=>k.startsWith(key+':recovery:')).map(k=>({key:k,raw:localStorage.getItem(k),draft:JSON.parse(localStorage.getItem(k))})),key);
  await page.goto(base);await workspace.edit(page,'VS2067');
  if(scenario==='new-image-archive-failure'){
    await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();
    await page.evaluate(key=>{window.firstArchiveSet=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name.startsWith(key+':recovery:'))throw new DOMException('Synthetic initial archive quota','QuotaExceededError');return window.firstArchiveSet.call(this,name,value);};},key);
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});
    await workspace.disclosure(page,'画像・現場名');await page.locator('input[type=file]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();
    await page.waitForFunction(({key,b})=>JSON.parse(localStorage.getItem(key)).resultJobId===b,{key,b});
    await page.evaluate(()=>{Storage.prototype.setItem=window.firstArchiveSet;});assert.equal(submitted,true);checks++;
    assert.equal((await current()).parsed.items[0].order_quantity,12);checks++;
    assert.equal((await archived()).length,0);checks++;
    await context.close();continue;
  }else await page.getByText('別の解析結果があります',{exact:true}).waitFor();
  assert.equal(await page.getByText('別の解析結果があります',{exact:true}).locator('..').getByRole('button').evaluateAll(nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth;})),true);checks++;
  if(scenario==='different-job'&&process.env.SOKUPA_SCREENSHOT)await page.screenshot({path:process.env.SOKUPA_SCREENSHOT,fullPage:true});
  let saved=await current();assert.equal(saved.parsed.items[0].order_quantity,46);assert.equal(saved.siteName,'Edited site A');assert.equal(saved.resultJobId,legacy?null:a);assert.equal(seenBCalls,0);checks++;
  await page.getByRole('button',{name:'今の編集を続ける',exact:true}).click();await page.getByTitle('タップして式を編集').click();await page.getByLabel('VS2067 1行目の幅数',{exact:true}).fill('3');
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].order_quantity===69,key);assert.equal(seenBCalls,0);checks++;
  await page.reload();await page.getByText('別の解析結果があります',{exact:true}).waitFor();saved=await current();assert.equal(saved.parsed.items[0].order_quantity,69);assert.equal(saved.resultJobId,legacy?null:a);assert.equal(seenBCalls,0);checks++;
  await page.evaluate(({key,scenario,b})=>{window.realWorkspaceSet=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(scenario==='primary-write-failure'?name===key&&JSON.parse(value).resultJobId===b:name.startsWith(key+':recovery:'))throw new DOMException('Synthetic quota','QuotaExceededError');return window.realWorkspaceSet.call(this,name,value);};},{key,scenario,b});
  await page.getByRole('button',{name:'選択した以前のデータを復元する',exact:true}).click();await page.getByText('今の下書きを保持しています。退避・切替できませんでした。',{exact:false}).waitFor();
  saved=await current();assert.equal(saved.parsed.items[0].order_quantity,69);assert.equal(saved.siteName,'Edited site A');assert.equal(seenBCalls,0);checks++;
  await page.evaluate(()=>{Storage.prototype.setItem=window.realWorkspaceSet;});await page.getByRole('button',{name:'選択した以前のデータを復元する',exact:true}).click();
  await page.waitForFunction(({key,b})=>JSON.parse(localStorage.getItem(key)).resultJobId===b,{key,b});await page.waitForTimeout(200);
  saved=await current();assert.equal(saved.siteName,'Server site B');assert.equal(saved.parsed.items[0].order_quantity,legacy?23:12);assert.equal(saved.orderDraftItems[0].quantity,9);assert.ok(seenBCalls>=1);checks++;
  const copies=await archived();assert.ok(copies.some(x=>x.draft.siteName==='Edited site A'&&x.draft.parsed.items[0].order_quantity===69&&x.draft.originalParsed.items[0].order_quantity===23));checks++;
  await page.getByText(/^退避した下書きを確認/).click();
  assert.equal(await page.getByText('退避した下書き',{exact:true}).locator('..').getByRole('button').evaluateAll(nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth;})),true);checks++;
  const exported=page.waitForEvent('download');await page.getByRole('button',{name:/「Edited site A」を書き出す/}).first().click();const file=await exported;const downloaded=JSON.parse(fs.readFileSync(await file.path(),'utf8'));assert.equal(downloaded.parsed.items[0].order_quantity,69);assert.equal(downloaded.orderDraftItems[0].quantity,9);checks++;
  await page.getByRole('button',{name:/「Edited site A」を復元/}).first().click();await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).siteName==='Edited site A',key);
  saved=await current();assert.equal(saved.parsed.items[0].order_quantity,69);assert.equal(saved.resultJobId,legacy?null:a);assert.ok((await archived()).some(x=>x.draft.resultJobId===b&&x.draft.siteName==='Server site B'));checks++;
  await page.reload();await workspace.edit(page,'VS2067');await page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();saved=await current();assert.equal(saved.siteName,'Edited site A');assert.equal(saved.parsed.items[0].order_quantity,69);assert.ok((await archived()).some(x=>x.draft.resultJobId===b));checks++;
  await context.close();
 }
 console.log(`PASS: ${checks} cross-job choice/archive/restore browser checks; known/unknown identity, quota/retry, export and reload; no external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
