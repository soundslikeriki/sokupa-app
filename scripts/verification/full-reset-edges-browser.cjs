// Actual app, isolated synthetic storage/APIs and clock. Never use fixture freshness migration here.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs');
const {resumeResultDraft,resetResultDraft,RESULT_DAY_MS:DAY}=require('../../src/lib/result-session.ts');
const {inspectCopyReview,prepareCopyReviewConfirmation}=require('../../src/lib/copy-review.ts');
const {planMemoOrder}=require('../../src/lib/order-planning.ts');
const bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];for(const base of bases)assert.equal(new URL(base).hostname,'127.0.0.1');
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const now=Date.now(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(ok,label)=>{assert.ok(ok,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<350;n++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Reset browser condition timed out');};
const make=()=>{
 const item={product_code:'ANON1',manufacturer:'Synthetic',entries:[{source_row_id:'r1',source_image_index:0,source_entry_index:0,original_formula:'20x1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:30,manual_order_quantity:30,reading_reviews:[{reason:'Synthetic correction candidate',candidate_formulas:['1x2'],source_image_index:0}]};
 const input={item,rows:[{id:'r1',length:20,quantity:1,active:false}],repeatCm:null,basis:'unconfirmed',match:'unconfirmed',lossRate:15,manualQuantity:30};
 const context={sourceJobId:A,siteName:'Result A',itemKey:'0:ANON1'},review=inspectCopyReview(input,context),ack=prepareCopyReviewConfirmation(input,context,review.token);
 // Seed a real old-format quantity flag to test preservation; new UI never creates it.
 item.quantity_confirmation=planMemoOrder({...input,readingReviewConfirmation:ack.readingReviewConfirmation}).fingerprint;item.reading_review_confirmation=ack.readingReviewConfirmation;
 return {version:1,siteName:'Next B',resultSiteName:'Result A',resultJobId:A,parsed:{items:[item]},originalParsed:{items:[{...structuredClone(item),order_quantity:23,manual_order_quantity:undefined}]},orderDraftItems:[{id:'keep',productCode:'KEEP',quantity:7,unit:'m',sourceType:'manual',sourceLabel:'Synthetic'}]};
};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const fixture=async(base,{age=0,choice=true,legacy=false,badTime,active=false,recover=false,pendingB=false,holdB=false,siteB='Next B',initial}={})=>{
  const owner='synthetic-reset',key=`sokupa:workspace:v1:${owner}`,latestKey=`sokupa:latest-result:v1:${owner}`;
  const seed=initial||await resumeResultDraft(make(),now-age);if(legacy)delete seed.resultSession;if(badTime!==undefined)seed.resultSession.meaningfulAt=badTime;
  const context=await browser.newContext({viewport:{width:base===bases[0]?390:320,height:844}}),page=await context.newPage(),dialogs=[],calls=[],errors=[],unexpected=[];
  const control={owner,active,recover,pendingB,siteB,holdB,releaseB:null,created:0,done:false,holdA:false,releaseA:null};
  await context.addInitScript(({key,seed,now})=>{
   if(!sessionStorage.getItem('reset-fixture-seeded')){if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(seed));sessionStorage.setItem('reset-fixture-seeded','1');}
   if(!localStorage.getItem('reset-fixture-clock'))localStorage.setItem('reset-fixture-clock',String(now));
   Date.now=()=>Number(localStorage.getItem('reset-fixture-clock'));window.setResetClock=value=>localStorage.setItem('reset-fixture-clock',String(value));window.copied=[];
   Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push(text);return Promise.resolve();}}});
  },{key,seed,now});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==base)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();calls.push({path:u.pathname,method:req.method()});
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:control.owner,admin:true}});
   if(u.pathname==='/api/analysis-jobs'&&req.method()==='GET')return route.fulfill({json:{data:control.active?[{id:B,status:'running',client_result_seen_at:null}]:control.pendingB?[{id:B,status:'done',site_name:control.siteB,client_result_seen_at:null,notification_status:'accepted'}]:control.recover?[{id:A,status:'done',client_result_seen_at:null,notification_status:'accepted'}]:[]}});
   if(u.pathname==='/api/memo-images')return route.fulfill({json:{object_path:`${owner}/${B}.jpg`}});
   if(u.pathname==='/api/analysis-jobs'&&req.method()==='POST'){control.created++;control.active=true;return route.fulfill({json:{success:true,job_id:B,execution_mode:'scheduled-wake',background_ready:true}});}
   if(u.pathname.endsWith('/seen'))return route.fulfill({json:{success:true}});
   if(u.pathname===`/api/analysis-jobs/${A}`){if(control.holdA)await new Promise(resolve=>{control.releaseA=resolve;});return route.fulfill({json:{data:{id:A,status:'done',site_name:'Result A',result:seed.originalParsed,total_images:1,done_images:1,notification_status:'accepted',can_resume:false}}});}
   if(u.pathname===`/api/analysis-jobs/${B}`){if(control.holdB)await new Promise(resolve=>{control.releaseB=()=>{control.holdB=false;resolve();};});const result={items:[{product_code:'ANONB',manufacturer:'Synthetic',entries:[{source_row_id:'b',source_image_index:0,source_entry_index:0,original_formula:'10x1',length_m:10,quantity:1,subtotal_m:10}],total_m:10,order_quantity:12}]},done=control.done||control.pendingB;return route.fulfill({json:{data:{id:B,status:done?'done':'running',site_name:control.siteB,result:done?result:null,total_images:1,done_images:done?1:0,notification_status:'accepted',can_resume:false,background_ready:true,execution_mode:'scheduled-wake'}}});}
   if(u.pathname.endsWith('/images/0'))return route.fulfill({contentType:'image/png',body:png});
   unexpected.push(u.pathname);return route.abort();
  });
  page.on('dialog',async dialog=>{if(dialog.type()==='confirm'){dialogs.push(dialog.message());if(choice)await dialog.accept();else await dialog.dismiss();}else await dialog.dismiss();});page.on('pageerror',e=>errors.push(e.message));
  const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);
  const bytes=()=>page.evaluate(k=>localStorage.getItem(k),key);
  const saved=async()=>{let previous='',stable=0;await wait(async()=>{const raw=await bytes();stable=raw===previous?stable+1:0;previous=raw;return stable>=3&&(await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');});};
  const photo=async()=>{await ui.view(page,'メモ画像');};
  const inputSite=()=>page.getByRole('region',{name:'メモ計測',exact:true}).getByLabel('現場名（任意）',{exact:true});
  const reset=()=>page.getByRole('button',{name:'すべてリセット',exact:true});
  const restore=()=>page.getByRole('button',{name:/^(前回の結果だけ戻す|リセット前の状態を復元)$/});
  await page.goto(base);await page.getByLabel('結果の保存状態').waitFor({state:'attached'});await saved();
  return {context,page,owner,key,latestKey,control,dialogs,calls,errors,unexpected,read,bytes,saved,photo,inputSite,reset,restore,choice};
 };

 for(const base of bases){
  {
   const h=await fixture(base);await ui.mode(h.page,'発注リスト');await h.page.getByRole('button',{name:'材料を手動追加',exact:true}).click();await h.page.getByLabel('品番（任意）',{exact:true}).fill('UNADDED');await h.page.getByRole('spinbutton',{name:'数量',exact:true}).fill('9');await ui.mode(h.page,'メモ計測');await h.photo();const before=await h.bytes();check(await h.reset().isDisabled(),'unadded manual draft disables full reset');await h.reset().evaluate(el=>el.click());check(await h.bytes()===before&&h.dialogs.length===0,'disabled reset neither saves nor confirms nor clears');await ui.mode(h.page,'発注リスト');check(await h.page.getByLabel('品番（任意）',{exact:true}).inputValue()==='UNADDED'&&await h.page.getByRole('spinbutton',{name:'数量',exact:true}).inputValue()==='9','unadded manual draft remains mounted and unchanged');await h.context.close();
  }
  {
   const h=await fixture(base);await ui.mode(h.page,'実寸計測');await h.page.getByLabel('施工面積',{exact:true}).fill('12');await h.page.locator('#area-product-code').fill('UNADDED-AREA');await ui.mode(h.page,'メモ計測');await h.photo();await h.reset().click();await h.saved();await ui.mode(h.page,'実寸計測');check(await h.page.getByLabel('施工面積',{exact:true}).inputValue()==='12'&&await h.page.locator('#area-product-code').inputValue()==='UNADDED-AREA','reset keeps unadded area form mounted rather than silently discarding it');await ui.mode(h.page,'メモ計測');await h.photo();await h.restore().click();await h.saved();check((await h.read()).orderDraftItems[0].quantity===7,'restoring full list does not substitute unadded area calculation');await h.context.close();
  }
  {
   const h=await fixture(base);await ui.mode(h.page,'発注リスト');await h.page.getByRole('button',{name:'材料を手動追加',exact:true}).click();await h.page.getByLabel('品番（任意）',{exact:true}).fill('KEEP');await h.page.getByRole('spinbutton',{name:'数量',exact:true}).fill('9');await h.page.getByRole('button',{name:'発注リストに追加',exact:true}).click();await h.page.getByRole('button',{name:'別項目で追加',exact:true}).waitFor();await ui.mode(h.page,'メモ計測');await h.photo();check(await h.reset().isDisabled()&&(await h.read()).orderDraftItems[0].quantity===7,'pending duplicate choice disables full reset without merging or losing queued input');await ui.mode(h.page,'発注リスト');check(await h.page.getByRole('button',{name:'別項目で追加',exact:true}).isVisible(),'duplicate choice is still available after navigation');await h.context.close();
  }
  {
   const h=await fixture(base);await h.photo();await h.reset().click();await h.saved();await ui.view(h.page,'概要');await ui.disclosure(h.page,'画像・現場名');await h.inputSite().fill('New C');await h.saved();await h.photo();await h.reset().click();await h.saved();let d=await h.read();check(h.dialogs.length===2&&h.dialogs[1].includes('前の戻す用保存は今回の結果に置き換わります'),'replacing existing full undo is stated in the one reset confirmation');check(d.resultSession.undo.parsed===null&&d.resultSession.undo.workspaceInputs.siteName==='New C','new reset replaces one undo without nesting the old A result');await h.page.reload();await h.saved();await h.photo();await h.restore().click();await h.saved();d=await h.read();check(d.parsed===null&&d.siteName==='New C'&&d.orderDraftItems.length===0&&d.resultSession.undo===null,'latest one state restores C rather than resurrecting older A or list');await h.context.close();
  }
  for(const part of['workspace','latest-result']){
   const h=await fixture(base);await h.photo();await h.reset().click();await h.saved();await h.photo();const before=await h.bytes();await h.page.evaluate(part=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(`sokupa:${part}:`))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,k,v);};},part);await h.restore().click();await h.page.getByRole('heading',{name:'エラー',exact:true}).waitFor();check(await h.bytes()===before&&(await h.read()).resultSession.undo.workspaceInputs.orderDraftItems[0].quantity===7,part+' failure preserves the full backup and empty current state');check(await h.page.getByRole('button',{name:'リセット前の状態を復元',exact:true}).isVisible(),'failed full undo does not consume the restore slot');await h.context.close();
  }
 }
 console.log(JSON.stringify({checks,normalAndBasic:true,synthetic:true,productionMutations:0,realAI:0,realLINE:0}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
