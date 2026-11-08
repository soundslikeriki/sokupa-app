const workspace = require('./result-workspace-helpers.cjs');
// Synthetic API fixtures; all non-localhost requests blocked.
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317',user='synthetic-user',id='00000000-0000-4000-8000-000000000001',pointer=`sokupa:lastJobId:${user}`;
const item={product_code:'VS2067',manufacturer:'Synthetic',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 const contextFor=async(handler)=>{const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>{throw e;});
 await workspace.freshResultFixtures(context);
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user,keep_open_for_progress:false}});if(url.pathname.startsWith('/api/'))return handler(route,url);return route.continue();});return{context,page};};
 try{
  let accepted=false,reads=0,discoveries=0,ready=true;
  const lost=await contextFor(async(route,url)=>{
   if(url.pathname==='/api/analysis-jobs'&&route.request().method()==='GET'){discoveries++;return route.fulfill({json:{data:accepted?[{id,status:'running'}]:[]}});}
   if(url.pathname==='/api/memo-images')return route.fulfill({json:{object_path:user+'/00000000-0000-4000-8000-000000000002.jpg'}});
   if(url.pathname==='/api/analysis-jobs'){accepted=true;return route.fulfill({json:{success:true,job_id:id,execution_mode:'scheduled-wake',background_ready:true}});}
   if(url.pathname===`/api/analysis-jobs/${id}`){reads++;return route.fulfill({json:{data:{id,status:'running',total_images:2,done_images:1,can_resume:false,execution_mode:'scheduled-wake',background_ready:ready}}});}
   throw Error('Unexpected API '+url.pathname);
  });
  await lost.context.addInitScript(()=>{const real=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('sokupa:lastJobId'))throw new DOMException('Synthetic quota','QuotaExceededError');return real.call(this,key,value);};});
  await lost.page.goto(base);const png=await lost.page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});
  await lost.page.locator('input[type=file]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await lost.page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await lost.page.getByText('解析を受け付けました',{exact:true}).waitFor();
  assert.equal(await lost.page.evaluate(key=>localStorage.getItem(key),pointer),null);checks++;
  await lost.page.reload();await lost.page.getByText('解析を受け付けました',{exact:true}).waitFor();assert.ok(discoveries>=2&&reads>=2);checks++;
  await lost.page.getByText('スマホを閉じても、完了後にLINEで通知します。',{exact:false}).waitFor();checks++;
  ready=false;await lost.page.getByText('サーバーの処理再開を待っています。',{exact:false}).waitFor();assert.equal(await lost.page.getByText('スマホを閉じても、完了後にLINEで通知します。',{exact:false}).count(),0);checks++;
  await lost.context.close();
  for(const firstStatus of [202,503]){
   let reads=0,resumes=0,recovery=false,notified=false,ack=0;
   const sample=await contextFor(async(route,url)=>{
    if(url.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:[{id,status:'done'}]}});
    if(url.pathname===`/api/analysis-jobs/${id}`){reads++;return route.fulfill({json:{data:{id,status:'done',site_name:'Synthetic',total_images:1,done_images:1,result:{items:[item]},notification_status:notified?'accepted':'failed',can_resume:!notified,execution_mode:'scheduled-wake',background_ready:true}}});}
    if(url.pathname===`/api/analysis-jobs/${id}/seen`){ack++;return route.fulfill({json:{success:true}});}
    if(url.pathname===`/api/analysis-jobs/${id}/resume`){resumes++;if(recovery)notified=true;return route.fulfill({status:recovery?202:firstStatus,json:{success:recovery||firstStatus===202}});}
    throw Error('Unexpected API '+url.pathname);
   });
   await sample.context.addInitScript(({key,id})=>{if(!sessionStorage.getItem('pointer-set')){localStorage.setItem(key,id);sessionStorage.setItem('pointer-set','true');}},{key:pointer,id});
   await sample.page.goto(base);await workspace.edit(sample.page, 'VS2067'); await sample.page.getByLabel('VS2067 の発注数量を入力',{exact:true}).waitFor();
   await sample.page.getByText('LINE通知を再確認しています。',{exact:false}).waitFor();assert.equal(await sample.page.evaluate(k=>localStorage.getItem(k),pointer),id);checks++;
   // A repeated failed-notification poll must not overwrite edits already shown to the user.
   await sample.page.getByTitle('タップして式を編集').click();await sample.page.getByLabel('VS2067 1行目の幅数',{exact:true}).fill('2');
   await sample.page.waitForTimeout(3300);assert.ok(reads>=2);assert.equal(await sample.page.getByLabel('VS2067 の発注数量を入力',{exact:true}).inputValue(),'46');checks++;
   assert.equal(await sample.page.evaluate(k=>localStorage.getItem(k),pointer),id);checks++;
   recovery=true;await sample.page.reload();await sample.page.waitForFunction(k=>localStorage.getItem(k)===null,pointer);assert.ok(resumes>=2&&notified&&ack>=1);checks++;
   await sample.context.close();
  }
  console.log(`PASS: ${checks} discovery, notification retry/edit retention and per-job mode browser checks; no external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
