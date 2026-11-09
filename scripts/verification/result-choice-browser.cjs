// Synthetic actual-app selection, storage failures and source provenance. Never use production URLs.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs'),bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b',C='00000000-0000-4000-8000-00000000000c';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<350;n++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Result choice condition timed out');};
const payload=quantity=>({items:[{product_code:'SYN-Q',manufacturer:'Synthetic',entries:[{source_row_id:'r0',source_image_index:0,source_entry_index:0,original_formula:'50×1',length_m:50,quantity:1,subtotal_m:50}],total_m:50,order_quantity:quantity,manual_order_quantity:quantity}]});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
const fixture=async(base,width,options={})=>{
 assert.equal(new URL(base).hostname,'127.0.0.1');const owner='synthetic-result-choice',key='sokupa:workspace:v1:'+owner,errors=[],unexpected=[],calls=[],dialogs=[];
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,acceptDownloads:true});await ui.freshResultFixtures(context);
 await context.addInitScript(({key,A,payload,options})=>{const clock=key+':clock';if(!localStorage.getItem(clock))localStorage.setItem(clock,String(Date.now()));Date.now=()=>Number(localStorage.getItem(clock));if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Next input C',resultSiteName:options.unnamed?'':'Edited A',resultJobId:A,parsed:payload,originalParsed:payload,...(options.undo?{resultSession:{version:1,generation:2,inactive:false,fingerprint:'',meaningfulAt:Date.now(),observedAt:Date.now(),allowedJobId:null,undo:{parsed:{items:[{product_code:'PREVIOUS',manufacturer:'Synthetic',entries:[],total_m:0,order_quantity:77}]},resultJobId:'00000000-0000-4000-8000-00000000000d',resultSiteName:'Previous77',meaningfulAt:Date.now()-1000}}}:{}),orderDraftItems:[{id:'keep',productCode:'KEEP',quantity:7,unit:'m',sourceType:'manual',sourceLabel:'Synthetic'}]}));},{key,A,payload:payload(59),options});
 await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==base){unexpected.push(u.origin);return route.abort();}if(!u.pathname.startsWith('/api/'))return route.continue();calls.push(req.method()+' '+u.pathname);
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
  if(u.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:u.searchParams.has('history')?[{id:C,status:'done',site_name:'Selected C',created_at:'2026-11-08T00:00:00Z'}]:[{id:B,status:'done',site_name:'Saved B',notification_status:'accepted',client_result_seen_at:null}]}});
  if(u.pathname===`/api/analysis-jobs/${B}`||u.pathname===`/api/analysis-jobs/${C}`){const isC=u.pathname.endsWith(C);return route.fulfill({json:{data:{id:isC?C:B,status:'done',site_name:isC?'Selected C':'Saved B',result:payload(isC?67:59),total_images:1,done_images:1,notification_status:'accepted',can_resume:false,background_ready:true}}});}
  if(u.pathname===`/api/analysis-jobs/${A}`)return route.fulfill({json:{data:{id:A,total_images:1}}});
  if(u.pathname.endsWith('/seen'))return route.fulfill({json:{success:true}});
  if(u.pathname.endsWith('/images/0'))return route.fulfill({contentType:'image/png',body:png});unexpected.push(req.method()+' '+u.pathname);return route.abort();
 });
 const page=await context.newPage();let accept=false;page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());if(accept)await d.accept();else await d.dismiss();});
 const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key),bytes=()=>page.evaluate(key=>localStorage.getItem(key),key);
 const saved=async()=>{let prior='',stable=0;await wait(async()=>{const raw=await bytes();stable=raw===prior?stable+1:0;prior=raw;return stable>=3&&(await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');});};
 const card=()=>page.getByLabel('表示する結果を選ぶ',{exact:true}),open=()=>card().getByRole('button',{name:'選択した以前のデータを復元する',exact:true});
 const keep=()=>card().getByRole('button',{name:'今の編集を続ける',exact:true});
 const clock=async delta=>page.evaluate(({key,delta})=>localStorage.setItem(key+':clock',String(Number(localStorage.getItem(key+':clock'))+delta)),{key,delta});
 await page.goto(base);await card().waitFor();await saved();await clock(60000);await page.getByRole('button',{name:'SYN-Q の発注数量を1m増やす',exact:true}).click();await wait(()=>read().then(d=>d.parsed.items[0].order_quantity===60));await saved();
 return {context,page,key,read,bytes,saved,card,open,keep,clock,errors,unexpected,calls,dialogs,accept:value=>accept=value};
};
for(const [mode,base]of bases.entries())for(const width of[320,390]){
 const h=await fixture(base,width,{unnamed:true,undo:true}),{page}=h;
 const exactChoices=async()=>{check(JSON.stringify(await h.card().getByRole('button').allTextContents())===JSON.stringify(['今の編集を続ける','選択した以前のデータを復元する']),'card exposes exactly the two requested actions');check(await h.card().locator('details,summary').count()===0&&!(await h.card().innerText()).includes('上書き'),'card has no hidden extra options or unbacked overwrite');};
 await exactChoices();const text=await h.card().innerText();check(text.includes('現場名なし')&&text.includes('Saved B')&&text.includes('SYN-Q: 60m')&&text.includes('SYN-Q: 59m')&&!text.includes('Next input C'),'unnamed current60m and named selected59m remain distinct from next-input name');
 const before=await h.bytes();await h.keep().click();await h.card().getByText('今の編集を続けています。',{exact:true}).waitFor();await h.saved();
 check(await h.bytes()===before,'continue editing preserves exact current bytes and meaningful age');await exactChoices();
 check(await page.evaluate(key=>JSON.parse(localStorage.getItem(key+':recovery:result:00000000-0000-4000-8000-00000000000b')).parsed.items[0].order_quantity===59,h.key),'continue retains selected59m without marking it seen');
 await page.reload();await h.card().waitFor();await h.saved();check((await h.read()).parsed.items[0].order_quantity===60&&(await h.read()).resultSiteName==='','reload after continue retains unnamed edited60m');await exactChoices();
 if(!mode&&process.env.SOKUPA_SCREENSHOT_DIR){await h.card().scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/two-choice-${width}.png`});}
 await ui.disclosure(page,'画像・現場名');await page.locator('input[type=file]').setInputFiles({name:'synthetic-next.png',mimeType:'image/png',buffer:png});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();
 await page.evaluate(key=>localStorage.setItem(key+':recovery:existing',JSON.stringify({...JSON.parse(localStorage.getItem(key)),siteName:'Older preserved',parsed:{items:[{product_code:'OLDER',manufacturer:'Synthetic',entries:[],total_m:0,order_quantity:77}]}})),h.key);
 const undoBefore=JSON.stringify((await h.read()).resultSession.undo);
 await h.clock(60000);const resumeAt=await page.evaluate(()=>Date.now());await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===B&&d.parsed.items[0].order_quantity===59));await h.saved();
 check((await h.read()).resultSiteName==='Saved B'&&(await h.read()).orderDraftItems[0].quantity===7,'verified save precedes named59m restore and retains the order draft');
 check(JSON.stringify((await h.read()).resultSession.undo)===undoBefore,'existing one-result undo77 is not replaced by history restore');
 check((await h.read()).resultSession.meaningfulAt===resumeAt,'explicit selected-result restore restarts24h at the saved restoration');
 check(await page.getByAltText('プレビュー 1',{exact:true}).count()===1,'restore preserves selected next photo');
 check((await ui.recoveryDrafts(page,h.key)).some(({draft:d})=>d?.resultJobId===A&&d.parsed?.items[0].order_quantity===60&&d.resultSiteName==='')&&await page.evaluate(key=>JSON.parse(localStorage.getItem(key+':recovery:existing')).parsed.items[0].order_quantity===77,h.key),'verified unnamed60m archive and older77m both remain recoverable');
 await page.reload();await h.saved();check((await h.read()).parsed.items[0].order_quantity===59&&(await h.read()).resultSiteName==='Saved B','restored59m and its source name survive reload');
 await page.getByText(/^直前の下書きを確認/).click();const restore=page.getByRole('button',{name:'直前の下書き「現場名なし」を復元',exact:true});await restore.click();await wait(()=>h.read().then(d=>d.resultJobId===A&&d.parsed.items[0].order_quantity===60));await h.saved();
 check((await h.read()).resultSiteName===''&&(await h.read()).orderDraftItems[0].quantity===7,'after reload, backed-up60m is restorable with its original unnamed result');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'two-choice UI fits mobile width');
 check(h.errors.length===0&&h.unexpected.length===0&&h.calls.every(call=>call.startsWith('GET ')||call.endsWith('/seen')),'choice paths remain synthetic with no provider/LINE request');await h.context.close();
}
for(const pending of['code','new-row']){
 const h=await fixture(bases[0],390),{page}=h;await ui.edit(page,'SYN-Q');
 if(pending==='code'){await page.getByTitle('タップして品番を編集',{exact:true}).click();await page.getByLabel('品番を編集',{exact:true}).fill('UNCOMMITTED');}
 else await page.getByLabel('SYN-Q に追加する長さ (m)',{exact:true}).fill('1.25');
 await h.open().click();await page.getByRole('heading',{name:'エラー',exact:true}).waitFor();
 check((await h.read()).resultJobId===A&&(await h.read()).parsed.items[0].order_quantity===60,pending+': uncommitted local editor input prevents result replacement');
 check(pending==='code'?await page.getByLabel('品番を編集',{exact:true}).inputValue()==='UNCOMMITTED':await page.getByLabel('SYN-Q に追加する長さ (m)',{exact:true}).inputValue()==='1.25',pending+': attempted selection preserves the exact raw local draft');
 check(!h.calls.some(call=>call.startsWith('POST /api/memo-corrections')),pending+': navigation never implicitly submits a code correction');await h.context.close();
}
for(const base of bases)for(const failure of['mirror-begin','mirror-readback','primary','mirror-complete']){
 const h=await fixture(base,390),{page}=h;const latestBefore=await page.evaluate(key=>localStorage.getItem('sokupa:latest-result:v1:'+encodeURIComponent(key.slice('sokupa:workspace:v1:'.length))),h.key);
 await page.evaluate(({key,failure})=>{const latest='sokupa:latest-result:v1:'+encodeURIComponent(key.slice('sokupa:workspace:v1:'.length));window.realSetItem=Storage.prototype.setItem;window.realGetItem=Storage.prototype.getItem;let writes=0,bad=false;Storage.prototype.getItem=function(k){const v=window.realGetItem.call(this,k);if(k===latest&&bad){bad=false;return 'invalid readback';}return v;};Storage.prototype.setItem=function(k,v){if(k===latest){writes++;if(failure==='mirror-begin'&&writes===1||failure==='mirror-complete'&&writes===2)throw new DOMException('Synthetic full','QuotaExceededError');}if(failure==='primary'&&k===key)throw new DOMException('Synthetic full','QuotaExceededError');window.realSetItem.call(this,k,v);if(k===latest&&writes===1&&failure==='mirror-readback')bad=true;};},{key:h.key,failure});
 await h.open().click();await page.getByRole('heading',{name:'エラー',exact:true}).waitFor();check((await h.read()).resultJobId===A&&(await h.read()).parsed.items[0].order_quantity===60,failure+': failed save never replaces60m with59m');
 check(await h.card().isVisible()&&!h.calls.some(call=>call==='POST /api/analysis-jobs/'+B+'/seen'),failure+': pending result remains actionable and unacknowledged');
 check(await page.evaluate(key=>localStorage.getItem('sokupa:latest-result:v1:'+encodeURIComponent(key.slice('sokupa:workspace:v1:'.length))),h.key)===latestBefore,failure+': failed switch restores exact prior latest-result bytes');
 await page.evaluate(()=>{Storage.prototype.setItem=window.realSetItem;Storage.prototype.getItem=window.realGetItem;});await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===B&&d.parsed.items[0].order_quantity===59));await h.saved();
 check((await h.read()).resultSiteName==='Saved B',failure+': explicit retry opens59m only after storage works');
 check((await ui.recoveryDrafts(page,h.key)).filter(({draft:d})=>d?.resultJobId===A&&d.parsed?.items[0].order_quantity===60).length===1,failure+': retry retains exactly one verified60m backup');await h.context.close();
}
{
 const h=await fixture(bases[0],390),{page}=h;
 await page.evaluate(key=>{window.held=false;void navigator.locks.request(key+':write',()=>new Promise(resolve=>{window.held=true;window.releaseChoiceLock=resolve;}));},h.key);await wait(()=>page.evaluate(()=>window.held));
 await h.open().click();await ui.disclosure(page,'保存済みの結果を開く');await page.getByRole('button',{name:'保存済みの解析結果を探す',exact:true}).click();await page.getByRole('button',{name:'保存済み「Selected C」の結果を確認',exact:true}).click();
 await wait(()=>h.card().innerText().then(text=>text.includes('Selected C')));await page.evaluate(()=>window.releaseChoiceLock());await page.getByRole('heading',{name:'エラー',exact:true}).waitFor();
 check((await h.read()).parsed.items[0].order_quantity===60&&(await h.read()).resultJobId===A,'a different arriving selection invalidates the waiting choice without changing current60m');
 await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===C));check((await h.read()).parsed.items[0].order_quantity===67&&(await h.read()).resultSiteName==='Selected C','explicitly selecting again opens current C, never the stale59m B');await h.context.close();
}
// Continue-save for B cannot acknowledge a newly selected C while waiting for the lock.
for(const base of bases){
 const h=await fixture(base,390),{page}=h;await page.evaluate(key=>{window.held=false;void navigator.locks.request(key+':write',()=>new Promise(resolve=>{window.held=true;window.releaseChoiceLock=resolve;}));},h.key);await wait(()=>page.evaluate(()=>window.held));
 await h.keep().click();await ui.disclosure(page,'保存済みの結果を開く');await page.getByRole('button',{name:'保存済みの解析結果を探す',exact:true}).click();await page.getByRole('button',{name:'保存済み「Selected C」の結果を確認',exact:true}).click();await wait(()=>h.card().innerText().then(t=>t.includes('Selected C')));await page.evaluate(()=>window.releaseChoiceLock());
 await wait(()=>page.evaluate(key=>Boolean(localStorage.getItem(key+':recovery:result:00000000-0000-4000-8000-00000000000b')),h.key));await h.saved();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 check(await h.card().getByText('今の編集を続けています。',{exact:true}).count()===0,'B save completion never marks new candidate C as deferred');
 check((await h.read()).parsed.items[0].order_quantity===60&&(await h.read()).resultJobId===A,'waiting continue keeps current60m unchanged');
 await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===C&&d.parsed.items[0].order_quantity===67));check((await h.read()).resultSiteName==='Selected C','C remains directly restorable after stale B continue');await h.context.close();
}
// Double taps serialize; another tab changing the primary is never overwritten.
for(const base of bases){
 const h=await fixture(base,390),{page}=h;await h.open().dblclick();await wait(()=>h.read().then(d=>d.resultJobId===B));await h.saved();
 const archived=(await ui.recoveryDrafts(page,h.key)).filter(({draft:d})=>d?.resultJobId===A&&d.parsed?.items[0].order_quantity===60).length;check(archived===1,'double restore creates one verified60m archive, not duplicate replacements');await h.context.close();
 const other=await fixture(base,390),p=other.page;await p.evaluate(key=>{window.held=false;void navigator.locks.request(key+':write',()=>new Promise(resolve=>{window.held=true;window.releaseChoiceLock=resolve;}));},other.key);await wait(()=>p.evaluate(()=>window.held));await other.open().click();
 const tab=await other.context.newPage();await tab.goto(base+'/manifest.webmanifest');await tab.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key));d.parsed.items[0].order_quantity=d.parsed.items[0].manual_order_quantity=70;localStorage.setItem(key,JSON.stringify(d));},other.key);await p.evaluate(()=>window.releaseChoiceLock());await p.getByRole('heading',{name:'エラー',exact:true}).waitFor();check((await other.read()).parsed.items[0].order_quantity===70&&await other.card().isVisible(),'second-tab70m remains intact and pending59m is not silently applied');check(await p.getByLabel('SYN-Q の一覧発注数量',{exact:true}).innerText()==='60m','cross-tab conflict retains current visible60m for recovery');await other.context.close();
}
// Saved selected59m uses the existing24/48-hour policy; current60m archive survives both.
for(const hours of[24,48])for(const base of bases){
 const h=await fixture(base,390),{page}=h;await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===B));await h.saved();await h.clock((24-1/60)*3600000);await page.reload();await h.saved();check((await h.read()).parsed.items[0].order_quantity===59,'before'+hours+'h saved selected59m is retained');
 await h.clock((hours-24)*3600000+60000);if(hours===24)h.accept(true);await page.reload();
 if(hours===24){await h.saved();check(h.dialogs.some(t=>t.includes('24時間以上')&&t.includes('Saved B')),'24h asks about the selected59m result with its own source name');check((await h.read()).parsed.items[0].order_quantity===59,'24h explicit resume preserves59m');}
 else {await wait(()=>h.read().then(d=>d.parsed===null&&d.resultSession?.undo?.parsed.items[0].order_quantity===59));check((await h.read()).resultSession.undo.resultSiteName==='Saved B','48h clears display only and keeps selected59m in the one-result undo');await ui.view(page,'メモ画像');await page.getByRole('button',{name:'前回の結果だけ戻す',exact:true}).click();await wait(()=>h.read().then(d=>d.parsed?.items[0].order_quantity===59));await h.saved();check((await h.read()).resultSiteName==='Saved B','48h manual one-result restore returns59m with its source name');}
 check((await ui.recoveryDrafts(page,h.key)).some(({draft:d})=>d?.resultJobId===A&&d.parsed?.items[0].order_quantity===60),'original60m archive survives'+hours+'h policy');await h.context.close();
}
for(const base of bases){const h=await fixture(base,390),{page}=h;await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===B));await h.saved();await h.clock(24*3600000);await page.reload();await wait(()=>h.read().then(d=>d.parsed===null&&d.resultSession?.undo?.parsed.items[0].order_quantity===59));check(h.dialogs.some(t=>t.includes('24時間以上')),'24h Cancel is an explicit native confirmation decision');await ui.view(page,'メモ画像');await page.getByRole('button',{name:'前回の結果だけ戻す',exact:true}).click();await wait(()=>h.read().then(d=>d.parsed?.items[0].order_quantity===59));await h.saved();check((await h.read()).resultSiteName==='Saved B','24h declined display remains recoverable as59m, not60m');await h.context.close();}
console.log(JSON.stringify({checks,widths:[320,390],normalBasic:true,synthetic:true,realAI:0,realLINE:0,productionMutations:0}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
