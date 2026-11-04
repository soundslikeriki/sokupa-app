// No external calls. Notification A fails while a different analysis B is accepted and completed.
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317',user='synthetic-user',a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b',key=`sokupa:workspace:v1:${user}`,pointer=`sokupa:lastJobId:${user}`;
const item=(code,m,q,order)=>({product_code:code,manufacturer:'Synthetic',entries:[{original_formula:`${m}×1`,length_m:m,quantity:q,subtotal_m:m*q}],total_m:m*q,order_quantity:order});
const original=item('A-CODE',20,1,23),draft={version:1,siteName:'Site A',parsed:{items:[item('A-CODE',20,2,46)]},originalParsed:{items:[original]},orderDraftItems:[],resultJobId:a};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 const wait=async(fn,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('synthetic condition timed out');};
 try{for(const scenario of [{status:202,delayed:false},{status:503,delayed:false},{status:503,delayed:true}]){
  const initialRetryStatus=scenario.status;let delayInitialA=scenario.delayed,releaseInitialA;const initialAGate=new Promise(resolve=>{releaseInitialA=resolve;});
  let statusA='failed',statusB='failed',created=false,doneB=false,recoverA=false,resumesA=0,resumesB=0,readsA=0,seenB=0,failAReadOnce=false,transientAReadObserved=false;
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>{throw e;});
  await context.addInitScript(({key,pointer,a,draft})=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem(key,JSON.stringify(draft));localStorage.setItem(pointer,a);sessionStorage.setItem('seeded','yes');}let offset=0;const realNow=Date.now;Date.now=()=>realNow()+offset;window.advanceNotificationClock=ms=>{offset+=ms;};},{key,pointer,a,draft});
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user}});
   if(url.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[...(created?[{id:b,status:doneB?'done':'running',site_name:'Site A',notification_status:statusB,client_result_seen_at:seenB?'stored':null}]:[]),...(statusA==='accepted'?[]:[{id:a,status:'done',site_name:'Site A',notification_status:statusA,client_result_seen_at:'stored'}])]}});
   if(url.pathname==='/api/analysis-jobs'){created=true;await route.fulfill({json:{success:true,job_id:b,execution_mode:'scheduled-wake',background_ready:true}});releaseInitialA();return;}
   if(url.pathname==='/api/memo-images')return route.fulfill({json:{object_path:user+'/00000000-0000-4000-8000-000000000002.jpg'}});
   if(url.pathname===`/api/analysis-jobs/${a}`){readsA++;if(delayInitialA){delayInitialA=false;await initialAGate;}if(failAReadOnce){failAReadOnce=false;transientAReadObserved=true;return route.fulfill({status:503,json:{error:'Synthetic notification lookup outage'}});}return route.fulfill({json:{data:{id:a,status:'done',client_result_seen_at:'stored',site_name:'Site A',total_images:1,done_images:1,result:{items:[original]},notification_status:statusA,can_resume:statusA==='failed',execution_mode:'scheduled-wake',background_ready:true}}});}
   if(url.pathname===`/api/analysis-jobs/${b}`)return route.fulfill({json:{data:{id:b,status:doneB?'done':'running',client_result_seen_at:seenB?'stored':null,site_name:'Site A',total_images:1,done_images:doneB?1:0,result:doneB?{items:[item('B-CODE',10,1,12)]}:null,notification_status:statusB,can_resume:doneB&&statusB==='failed',execution_mode:'scheduled-wake',background_ready:true}}});
   if(url.pathname===`/api/analysis-jobs/${a}/resume`){resumesA++;if(recoverA)statusA='accepted';return route.fulfill({status:recoverA?202:initialRetryStatus,json:{success:recoverA||initialRetryStatus===202}});}
   if(url.pathname===`/api/analysis-jobs/${b}/resume`){resumesB++;return route.fulfill({status:503,json:{error:'Synthetic B notification unavailable'}});}
   if(url.pathname===`/api/analysis-jobs/${a}/seen`)return route.fulfill({json:{success:true}});
   if(url.pathname===`/api/analysis-jobs/${b}/seen`){seenB++;return route.fulfill({json:{success:true}});}
   if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);return route.continue();
  });
  const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const upload=async()=>{const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});await page.locator('input[type=file]').setInputFiles({name:'next.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();};
  await page.goto(base);if(!scenario.delayed)await page.getByText('LINE通知を再確認しています。',{exact:false}).waitFor();await page.getByLabel('A-CODE の発注数量を入力',{exact:true}).waitFor();
  await page.getByTitle('タップして式を編集').click();await page.getByLabel('A-CODE 1行目の幅数',{exact:true}).fill('3');await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).parsed.items[0].order_quantity===69,key);
  await upload();const button=page.getByRole('button',{name:'1枚の画像を解析する',exact:true});await wait(()=>button.isEnabled());assert.equal(statusA,'failed');if(!scenario.delayed)assert.ok(resumesA>=1);checks++;
  if(initialRetryStatus===503)await page.evaluate(key=>{window.realArchiveSet=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name.startsWith(key+':recovery:'))throw new DOMException('Synthetic archive quota','QuotaExceededError');return window.realArchiveSet.call(this,name,value);};},key);
  await button.click();await page.getByText('解析を受け付けました',{exact:true}).waitFor();assert.equal(created,true);assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),b);await wait(()=>resumesA>=1);checks++;
  if(initialRetryStatus===503){assert.equal((await read()).parsed.items[0].order_quantity,69);await page.evaluate(()=>{Storage.prototype.setItem=window.realArchiveSet;});}
  else assert.equal((await read()).parsed.items[0].order_quantity,69);checks++;
  failAReadOnce=true;await wait(()=>transientAReadObserved);assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),b);assert.equal(await button.isDisabled(),true);checks++;
  recoverA=true;await page.evaluate(()=>window.advanceNotificationClock(31_000));await wait(()=>statusA==='accepted');await page.getByText('Site A: LINE受付済み',{exact:true}).waitFor();
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),b);assert.equal(await button.isDisabled(),true);assert.ok(resumesA>=2&&readsA>=3);checks++;
  const whileB=await read();assert.equal(whileB.parsed?.items[0]?.product_code??null,'A-CODE');checks++;
  doneB=true;
  await page.getByLabel('B-CODE の発注数量を入力',{exact:true}).waitFor();await wait(()=>button.isEnabled());assert.equal(statusB,'failed');assert.equal((await read()).parsed.items[0].order_quantity,12);checks++;
  assert.equal(await page.evaluate(key=>Object.keys(localStorage).filter(k=>k.startsWith(key+':recovery:')).length,key),0);checks++;
  await page.reload();await page.getByLabel('B-CODE の発注数量を入力',{exact:true}).waitFor();await page.getByText('LINE通知を再確認しています。',{exact:false}).waitFor();await upload();await wait(()=>page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).isEnabled());
  assert.equal((await read()).resultJobId,b);assert.equal((await read()).parsed.items[0].order_quantity,12);assert.ok(resumesB>=1);assert.equal(statusB,'failed');checks++;
  await context.close();
 }
 // A completed job can have an unavailable result endpoint. Its metadata must not lock new intake.
 {const c='00000000-0000-4000-8000-00000000000c';let created=false,reads=0,releaseOld=false,seenB=0;
  const context=await browser.newContext(),page=await context.newPage();
  await context.addInitScript(({key,draft})=>localStorage.setItem(key,JSON.stringify(draft)),{key,draft});
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user}});
   if(url.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[{id:b,status:'done',notification_status:'failed',site_name:'Site B',client_result_seen_at:null}]}});
   if(url.pathname==='/api/analysis-jobs'){created=true;return route.fulfill({json:{success:true,job_id:c,execution_mode:'scheduled-wake',background_ready:true}});}
   if(url.pathname==='/api/memo-images')return route.fulfill({json:{object_path:user+'/synthetic.jpg'}});
   if(url.pathname===`/api/analysis-jobs/${b}`){reads++;return releaseOld?route.fulfill({json:{data:{id:b,status:'done',site_name:'Site B',result:{items:[item('B-CODE',10,1,12)]},notification_status:'failed',can_resume:false}}}):route.fulfill({status:503,json:{error:'Synthetic result outage'}});}
   if(url.pathname===`/api/analysis-jobs/${c}`)return route.fulfill({json:{data:{id:c,status:'running',site_name:'Site A',result:null,total_images:1,done_images:0,can_resume:false,execution_mode:'scheduled-wake',background_ready:true}}});
   if(url.pathname===`/api/analysis-jobs/${a}/seen`)return route.fulfill({json:{success:true}});
   if(url.pathname===`/api/analysis-jobs/${b}/seen`){seenB++;return route.fulfill({json:{success:true}});}
   if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);return route.continue();
  });
  await page.goto(base);await page.getByText('解析が完了しました',{exact:true}).waitFor();await wait(()=>reads>=1);
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});
  await page.locator('input[type=file]').setInputFiles({name:'next.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();
  const button=page.getByRole('button',{name:'1枚の画像を解析する',exact:true});await wait(()=>button.isEnabled());assert.equal(seenB,0);checks++;
  await button.click();await page.getByText('解析を受け付けました',{exact:true}).waitFor();assert.ok(created);assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),c);checks++;
  const before=reads;releaseOld=true;await wait(()=>reads>before);assert.equal(await button.isDisabled(),true);assert.equal(await page.getByText('別の解析結果があります',{exact:true}).count(),0);
  assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).parsed.items[0].order_quantity,key),46);assert.equal(seenB,0);assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),c);checks++;
  await context.close();
 }
 console.log(`PASS: ${checks} notification/new-analysis browser checks; 202/503, result lookup failure, A recovery during B, reload and draft safety; no external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
