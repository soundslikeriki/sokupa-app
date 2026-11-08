// Actual app, isolated synthetic storage/APIs and clock. Never use fixture freshness migration here.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs');
const {resumeResultDraft,resetResultDraft,RESULT_DAY_MS:DAY}=require('../../src/lib/result-session.ts');
const {inspectCopyReview,prepareCopyReviewConfirmation}=require('../../src/lib/copy-review.ts');
const bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];for(const base of bases)assert.equal(new URL(base).hostname,'127.0.0.1');
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const now=Date.now(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(ok,label)=>{assert.ok(ok,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<350;n++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Reset browser condition timed out');};
const make=()=>{
 const item={product_code:'ANON1',manufacturer:'Synthetic',entries:[{source_row_id:'r1',source_image_index:0,source_entry_index:0,original_formula:'20x1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:30,manual_order_quantity:30,reading_reviews:[{reason:'Synthetic correction candidate',candidate_formulas:['1x2'],source_image_index:0}]};
 const input={item,rows:[{id:'r1',length:20,quantity:1,active:false}],repeatCm:null,basis:'unconfirmed',match:'unconfirmed',lossRate:15,manualQuantity:30};
 const context={sourceJobId:A,siteName:'Result A',itemKey:'0:ANON1'},review=inspectCopyReview(input,context),ack=prepareCopyReviewConfirmation(input,context,review.token);
 item.quantity_confirmation=ack.quantityConfirmation;item.reading_review_confirmation=ack.readingReviewConfirmation;
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
  const saved=async()=>{await wait(()=>page.getByLabel('結果の保存状態').innerText().then(s=>s.includes('保存済み')));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
  const photo=async()=>{await ui.view(page,'元写真');};
  const inputSite=()=>page.getByRole('region',{name:'メモ計測',exact:true}).getByLabel('現場名（任意）',{exact:true});
  const reset=()=>page.getByRole('button',{name:'この結果の表示をリセット',exact:true});
  const restore=()=>page.getByRole('button',{name:'前回の結果だけ戻す',exact:true});
  await page.goto(base);await page.getByLabel('結果の保存状態').waitFor();await saved();
  return {context,page,owner,key,latestKey,control,dialogs,calls,errors,unexpected,read,bytes,saved,photo,inputSite,reset,restore,choice};
 };
 for(const base of bases){
  for(const age of[0,DAY-1,DAY,2*DAY-1,2*DAY]){
   const h=await fixture(base,{age});
   if(age<2*DAY){await h.page.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();check((await h.read()).parsed.items[0].order_quantity===30,`${age}: edited final quantity retained`);check(h.dialogs.length===(age<DAY?0:1),`${age}: exact24h confirmation boundary`);if(age<DAY)check((await h.read()).resultSession.meaningfulAt===now-age,'opening does not renew meaningful time');else check((await h.read()).resultSession.meaningfulAt===now,'explicit age resume restarts24h');}
   else {check((await h.read()).parsed===null&&h.dialogs.length===0,'48h clears display without deleting undo or requiring an extra prompt');await h.photo();check(await h.restore().isEnabled()&&(await h.read()).resultSession.undo.parsed.items[0].order_quantity===30,'48h original-photo tab exposes the edited previous result');await h.restore().click();await h.saved();check((await h.read()).parsed.items[0].quantity_confirmation&&!(await h.read()).resultSession.undo,'48h manual restore keeps confirmation and consumes one slot');}
   check((await h.read()).orderDraftItems[0].quantity===7&&(await h.read()).siteName==='Next B','age policy preserves next input and order drafts');check(h.errors.length===0&&h.unexpected.length===0,'age entry has no runtime or unexpected API error');await h.context.close();
  }
  {
   const h=await fixture(base,{age:DAY,choice:false});check((await h.read()).parsed===null&&h.dialogs.length===1,'24h decline keeps one recoverable result without displaying it');await h.page.reload();await h.saved();check((await h.read()).parsed===null&&h.dialogs.length===1,'declined display never reappears automatically after reload');await h.context.close();
  }
  {
   const h=await fixture(base,{choice:false});await h.photo();const before=await h.bytes();await h.reset().click();await h.saved();check(await h.bytes()===before&&h.dialogs.length===1,'manual Cancel changes no result or confirmation bytes');await h.context.close();
  }
  {
   const h=await fixture(base,{recover:true});await ui.disclosure(h.page,'画像・現場名');await h.page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await h.page.getByAltText('プレビュー 1',{exact:true}).waitFor();await h.photo();await h.reset().click();await h.saved();
   check((await h.read()).parsed===null&&(await h.read()).resultSession.undo.resultJobId===A&&h.dialogs.length===1,'manual reset uses one explicit warning and saves this job only');await ui.disclosure(h.page,'画像・現場名');check(await h.page.getByAltText('プレビュー 1',{exact:true}).isVisible(),'reset preserves unsubmitted selected photo');
   await h.page.reload();await h.saved();check((await h.read()).parsed===null,'manual reset wins over under24h and unseen server discovery');await h.photo();await h.restore().click();await h.saved();check((await h.read()).resultSiteName==='Result A'&&(await h.read()).siteName==='Next B','restore keeps A source name independent of next input B');
   check((await h.read()).orderDraftItems[0].quantity===7&&(await h.read()).parsed.items[0].order_quantity===30,'restore changes no order draft or edited final quantity');
   await ui.view(h.page,'数量');check(await h.page.getByLabel('ANON1 の一覧で訂正・取消と発注数量を確認した',{exact:true}).isChecked(),'restored fingerprint remains valid for unchanged A');await h.page.getByRole('button',{name:'確認してコピー',exact:true}).click();await h.page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).click();check(await h.page.evaluate(()=>window.copied.at(-1).includes('Result A')&&!window.copied.at(-1).includes('Next B')),'copy uses the restored result name, never the next input name');await h.context.close();
  }
 }
 for(const extra of[{legacy:true},{badTime:'invalid'},{badTime:now+DAY}]){const h=await fixture(bases[0],{...extra,choice:false});check(h.dialogs.length===1&&(await h.read()).resultSession.undo.parsed.items[0].order_quantity===30,'unknown/invalid/future time requires a choice and retains edited data');await h.context.close();}
 for(const base of bases){const seed=make();seed.parsed.items[0].entries[0].length_input='';const h=await fixture(base,{initial:await resumeResultDraft(seed,now-2*DAY)});check((await h.read()).parsed?.items[0].entries[0].length_input===''&&h.dialogs.length===0,'48h startup never hides persisted unfinished input before editor mounts');await h.photo();check(await h.reset().isDisabled(),'persisted unfinished result cannot be manually cleared');await h.context.close();}
 // Regression: ...current must not carry A's result name into explicitly opened B.
 for(const siteB of['Result B',''])for(const path of['manual','age']){
  const h=await fixture(bases[0],{pendingB:true,siteB});
  await h.page.getByRole('button',{name:'今の下書きを退避して別の結果を開く',exact:true}).click();await h.page.getByLabel('ANONB の一覧発注数量',{exact:true}).waitFor();await h.saved();
  check((await h.read()).resultJobId===B&&(await h.read()).resultSiteName===siteB,'pending B has its own exact source name, including no-name, never A');
  await ui.disclosure(h.page,'画像・現場名');await h.inputSite().fill('Next C');await h.saved();
  if(path==='manual'){await h.photo();await h.reset().click();await h.saved();}
  else {await h.page.evaluate(value=>window.setResetClock(value),now+2*DAY);await h.page.reload();await h.saved();}
  check((await h.read()).parsed===null&&(await h.read()).resultSession.undo.resultJobId===B&&(await h.read()).resultSession.undo.resultSiteName===siteB,`${path}: B alone is retained as previous1 with its own name`);
  await h.photo();await h.restore().click();await h.saved();
  check((await h.read()).resultJobId===B&&(await h.read()).resultSiteName===siteB&&(await h.read()).siteName==='Next C',`${path}: restore B preserves next-input C and does not revive A's name`);
  await ui.view(h.page,'数量');await h.page.getByLabel('ANONB の一覧で元メモと発注数量を確認した',{exact:true}).check();await h.saved();
  await h.page.getByRole('button',{name:'確認してコピー',exact:true}).click();await h.page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).click();
  const copied=await h.page.evaluate(()=>window.copied.at(-1));check(copied.includes('ANONB')&&!copied.includes('Result A')&&!copied.includes('Next C')&&(!siteB||copied.includes(siteB)),`${path}: B copy is bound to B or unnamed, never A/C`);
  check(h.errors.length===0&&h.unexpected.length===0,'pending-result regression has no runtime or unexpected API errors');await h.context.close();
 }
 {
  const h=await fixture(bases[0],{age:DAY-1});await h.page.reload();await h.saved();check(h.dialogs.length===0&&(await h.read()).resultSession.meaningfulAt===now-DAY+1,'ordinary reload never renews23h59m age');
  await h.page.evaluate(value=>window.setResetClock(value),now+1);await h.page.reload();await h.saved();check(h.dialogs.length===1,'the next reload reaches24h despite earlier automatic display');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await h.photo();await h.reset().click();await h.saved();await h.page.evaluate(key=>localStorage.removeItem(key),h.key);await h.page.reload();await h.saved();
  check((await h.read()).parsed===null&&(await h.read()).resultSession.undo.resultJobId===A,'missing primary recovers the blank display and undo, never resurrects A');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await h.photo();await h.reset().evaluate(button=>{button.click();button.click();});await h.saved();check(h.dialogs.length===1&&(await h.read()).resultSession.generation===2,'repeated reset clicks have one confirmation and one transition');
  check(await h.page.evaluate(key=>Object.keys(localStorage).filter(k=>k.startsWith(`${key}:recovery:`)).length===0,h.key),'result reset adds no accumulating archive keys');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await h.photo();await h.page.evaluate(key=>{window.holdingResetLock=false;void navigator.locks.request(`${key}:write`,()=>new Promise(resolve=>{window.holdingResetLock=true;window.releaseResetLock=resolve;}));},h.key);await wait(()=>h.page.evaluate(()=>window.holdingResetLock));
  await h.reset().click();await h.page.getByLabel('表示中の結果の現場名',{exact:true}).fill('Edited while waiting');await h.page.evaluate(()=>window.releaseResetLock());await h.page.getByRole('heading',{name:'エラー',exact:true}).waitFor();
  check((await h.read()).parsed!==null&&(await h.read()).resultSession.undo===null,'queued-lock content change prevents stale reset without erasing the current result');check(await h.page.getByLabel('表示中の結果の現場名',{exact:true}).inputValue()==='Edited while waiting','edit made during queued operation remains visible');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await h.photo();await h.reset().click();await h.saved();await ui.disclosure(h.page,'画像・現場名');await h.page.locator('input[type=file]').setInputFiles({name:'synthetic-B.png',mimeType:'image/png',buffer:png});await h.page.getByAltText('プレビュー 1',{exact:true}).waitFor();
  await h.page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>Promise.resolve(h.control.created===1));await h.page.getByText('解析を受け付けました',{exact:true}).waitFor();
  h.control.active=false;h.control.done=true;await h.page.getByLabel('ANONB の一覧発注数量',{exact:true}).waitFor();await h.saved();
  check((await h.read()).resultJobId===B&&(await h.read()).resultSession.undo.resultJobId===A,'new B autosave preserves reset A in the one undo slot');await h.photo();check(await h.restore().isDisabled(),'B cannot be silently overwritten by restoring A');
  await h.reset().click();await h.saved();check((await h.read()).resultSession.undo.resultJobId===B,'reset B explicitly replaces A rather than building an unlimited undo history');await h.photo();await h.restore().click();await h.saved();check((await h.read()).resultJobId===B&&(await h.read()).resultSession.undo===null,'restore consumes only the latest one result');
  check(h.control.created===1&&h.calls.every(call=>!['/api/parse-memo','/api/send-line'].includes(call.path))&&h.unexpected.length===0,'new-result fixture uses one synthetic admission and no AI/LINE endpoint');await h.context.close();
 }
 {
  const h=await fixture(bases[0],{age:2*DAY,active:true});await h.page.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();await h.photo();check(await h.reset().isEnabled()===false&&(await h.read()).parsed.items[0].order_quantity===30,'processing prevents automatic48h and manual reset');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await ui.edit(h.page,'ANON1');await h.page.getByTitle('タップして品番を編集',{exact:true}).click();await h.page.getByLabel('品番を編集',{exact:true}).fill('UNCOMMITTED');await h.photo();check(await h.reset().isEnabled()===false,'uncommitted code blocks reset without implicit correction submission');await h.page.evaluate(now=>{window.setResetClock(now);document.dispatchEvent(new Event('visibilitychange'));},now+3*DAY);check((await h.read()).parsed!==null,'foreground return never clears a working session');await ui.edit(h.page,'ANON1');check(await h.page.getByLabel('品番を編集',{exact:true}).inputValue()==='UNCOMMITTED','working draft survives safe-entry age skip');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await ui.edit(h.page,'ANON1');await h.page.getByLabel('ANON1 に追加する長さ (m)',{exact:true}).fill('2.5');await h.photo();check(await h.reset().isDisabled(),'unadded row blocks reset');await ui.edit(h.page,'ANON1');check(await h.page.getByLabel('ANON1 に追加する長さ (m)',{exact:true}).inputValue()==='2.5','unadded row survives photo navigation');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await ui.edit(h.page,'ANON1');await h.page.getByTitle('タップして式を編集',{exact:true}).click();await h.page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).fill('');await h.photo();check(await h.reset().isDisabled(),'unfinished numeric row blocks reset without normalizing blank');await ui.edit(h.page,'ANON1');check(await h.page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).inputValue()==='','blank row draft survives photo navigation');await h.context.close();
 }
 {
  const h=await fixture(bases[0],{pendingB:true,holdB:true});await wait(()=>Promise.resolve(Boolean(h.control.releaseB)));await h.photo();await h.reset().click();await h.saved();h.control.releaseB();await h.page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));check((await h.read()).parsed===null&&(await h.read()).resultSession.undo.resultJobId===A,'late completed-job response cannot resurrect display after reset');await h.page.reload();await h.saved();check((await h.read()).parsed===null,'automatic discovery remains suppressed after reload with late B');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);await h.page.evaluate(now=>{window.setResetClock(now);document.dispatchEvent(new Event('visibilitychange'));},now+2*DAY);await wait(()=>h.read().then(d=>d.parsed===null));check((await h.read()).resultSession.undo!==null,'idle foreground is a safe48h entry');await h.context.close();
 }
 for(const failedKey of['workspace','latest-result']){
  const h=await fixture(bases[0]);await h.photo();const before=await h.bytes();await h.page.evaluate(part=>{const old=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(`sokupa:${part}:`))throw new DOMException('Synthetic quota','QuotaExceededError');return old.call(this,k,v);};},failedKey);await h.reset().click();await h.page.getByRole('heading',{name:'エラー',exact:true}).waitFor();check((await h.read()).parsed.items[0].order_quantity===30&&await h.bytes()===before,`${failedKey}: storage failure never clears screen or current data`);check((await h.page.getByLabel('結果の保存状態').innerText()).includes('確認できません'),`${failedKey}: failed reset is never shown as saved`);await h.context.close();
 }
 {
  const h=await fixture(bases[0]);h.control.owner='synthetic-other';await h.photo();const before=await h.bytes();await h.reset().click();await h.page.getByRole('heading',{name:'エラー',exact:true}).waitFor();check(await h.bytes()===before&&(await h.read()).parsed!==null,'owner switch blocks reset without writing another account');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);const other=await h.context.newPage();await other.goto(bases[0]);await other.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();await wait(()=>other.getByLabel('結果の保存状態').innerText().then(s=>s.includes('保存済み')));
  await ui.disclosure(h.page,'画像・現場名');await h.inputSite().fill('First tab can still edit');await h.saved();check((await h.read()).siteName==='First tab can still edit'&&await h.page.getByRole('heading',{name:'エラー',exact:true}).count()===0,'opening another tab alone never freezes edits as a false conflict');await h.context.close();
 }
 {
  const h=await fixture(bases[0]);const other=await h.context.newPage();other.on('dialog',d=>d.accept());await other.goto(bases[0]);await other.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();await ui.disclosure(other,'画像・現場名');await other.getByRole('region',{name:'メモ計測',exact:true}).getByLabel('現場名（任意）',{exact:true}).fill('Other tab edit');await wait(()=>h.read().then(d=>d.siteName==='Other tab edit'));await h.page.getByRole('heading',{name:'エラー',exact:true}).waitFor();await h.photo();check(await h.reset().isEnabled()===false&&(await h.read()).siteName==='Other tab edit','competing tab keeps the newer saved workspace and disables stale reset');await h.context.close();
 }
 if(process.env.SOKUPA_SCREENSHOT_DIR){
  fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});for(const base of bases){const h=await fixture(base),width=base===bases[0]?390:320;await h.photo();await h.reset().scrollIntoViewIfNeeded();await h.page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/result-reset-photo-${width}.png`,fullPage:false});await h.reset().click();await h.saved();await h.photo();await h.page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/result-reset-recovery-${width}.png`,fullPage:false});check(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}: recovery controls fit narrow viewport`);check(await h.restore().evaluate(button=>button.getBoundingClientRect().height>=44),`${width}: restore touch target is at least44px`);await h.context.close();}
 }
 console.log(JSON.stringify({checks,synthetic:true,physicalSafari:false,realAiCalls:0,realLineSends:0,productionWrites:0}));
 }finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
