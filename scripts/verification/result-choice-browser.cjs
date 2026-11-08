// Synthetic actual-app selection, storage failures and source provenance. Never use production URLs.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs'),bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b',C='00000000-0000-4000-8000-00000000000c';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<350;n++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Result choice condition timed out');};
const payload=quantity=>({items:[{product_code:'SYN-Q',manufacturer:'Synthetic',entries:[{source_row_id:'r0',source_image_index:0,source_entry_index:0,original_formula:'50×1',length_m:50,quantity:1,subtotal_m:50}],total_m:50,order_quantity:quantity,manual_order_quantity:quantity}]});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
const fixture=async(base,width)=>{
 assert.equal(new URL(base).hostname,'127.0.0.1');const owner='synthetic-result-choice',key='sokupa:workspace:v1:'+owner,errors=[],unexpected=[],calls=[],dialogs=[];
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,acceptDownloads:true});await ui.freshResultFixtures(context);
 await context.addInitScript(({key,A,payload})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Next input C',resultSiteName:'Edited A',resultJobId:A,parsed:payload,originalParsed:payload,orderDraftItems:[{id:'keep',productCode:'KEEP',quantity:7,unit:'m',sourceType:'manual',sourceLabel:'Synthetic'}]}));},{key,A,payload:payload(59)});
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
 const card=()=>page.getByLabel('表示する結果を選ぶ',{exact:true}),open=()=>card().getByRole('button',{name:'今の編集を残して選んだ結果を開く',exact:true});
 const other=()=>card().getByLabel('結果切替のその他の操作',{exact:true});
 await page.goto(base);await card().waitFor();await saved();await page.getByRole('button',{name:'SYN-Q の発注数量を1m増やす',exact:true}).click();await wait(()=>read().then(d=>d.parsed.items[0].order_quantity===60));await saved();
 return {context,page,key,read,bytes,saved,card,open,other,errors,unexpected,calls,dialogs,accept:value=>accept=value};
};
for(const [mode,base]of bases.entries())for(const width of[320,390]){
 const h=await fixture(base,width),{page}=h;
 check(await h.card().getByRole('button').count()===2,'only two primary choices are exposed initially');
 const text=await h.card().innerText();check(text.includes('Edited A')&&text.includes('Saved B')&&text.includes('SYN-Q: 60m')&&text.includes('SYN-Q: 59m')&&!text.includes('Next input C'),'choice names and60m/59m use result provenance, never the next-input name');
 const before=await h.bytes();await h.other().locator('summary').click();check(await h.card().getByRole('button').count()===5,'other operations retain overwrite and both exports');
 for(const [name,quantity]of[['今の下書きを書き出す',60],['別の解析結果を書き出す',59]]){
  const download=page.waitForEvent('download');await h.card().getByRole('button',{name,exact:true}).click();const file=await download;const data=JSON.parse(fs.readFileSync(await file.path(),'utf8'));check(data.parsed.items[0].order_quantity===quantity,name+' keeps its own exact edited/source quantity');
 }
 await h.card().getByRole('button',{name:'今の編集を上書きして開く（退避しない）',exact:true}).click();await h.saved();
 check((await h.read()).parsed.items[0].order_quantity===60&&h.dialogs.at(-1).includes('60m')&&h.dialogs.at(-1).includes('59m'),'overwrite Cancel preserves60m and names both alternatives');
 await h.other().locator('summary').click();await h.saved();check(await h.bytes()===before,'disclosure/export/Cancel do not change current bytes or meaningful age');
 if(!mode&&process.env.SOKUPA_SCREENSHOT_DIR){await h.card().scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/result-choice-${width}.png`});}
 await ui.disclosure(page,'画像・現場名');await page.locator('input[type=file]').setInputFiles({name:'synthetic-next.png',mimeType:'image/png',buffer:png});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();
 await page.evaluate(key=>localStorage.setItem(key+':recovery:existing',JSON.stringify({...JSON.parse(localStorage.getItem(key)),siteName:'Older preserved',parsed:{items:[{product_code:'OLDER',manufacturer:'Synthetic',entries:[],total_m:0,order_quantity:77}]}})),h.key);
 await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===B&&d.parsed.items[0].order_quantity===59));await h.saved();
 check((await h.read()).resultSiteName==='Saved B'&&(await h.read()).orderDraftItems[0].quantity===7,'safe choice opens59m with its own site and retains the order draft');
 check(await page.getByAltText('プレビュー 1',{exact:true}).count()===1,'switch preserves the selected next photo');
 check(await page.evaluate(({key,A})=>Object.keys(localStorage).filter(k=>k.startsWith(key+':recovery:')).some(k=>{const d=JSON.parse(localStorage.getItem(k));return d.resultJobId===A&&d.parsed?.items[0].order_quantity===60;})&&JSON.parse(localStorage.getItem(key+':recovery:existing')).parsed.items[0].order_quantity===77,{key:h.key,A}),'old60m and the previously preserved77m both remain recoverable');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'two-choice UI fits mobile width');
 check(h.errors.length===0&&h.unexpected.length===0&&h.calls.every(call=>call.startsWith('GET ')||call.endsWith('/seen')),'all choices use only synthetic reads/receipts, no provider/LINE call');await h.context.close();if(process.env.SOKUPA_CHOICE_REPRO==='1')return;
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
for(const failure of['archive','primary','latest']){
 const h=await fixture(bases[0],390),{page}=h;await page.evaluate(({key,failure})=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(failure==='archive'&&k.startsWith(key+':recovery:')||failure==='primary'&&k===key||failure==='latest'&&k.startsWith('sokupa:latest-result:'))throw new DOMException('Synthetic storage full','QuotaExceededError');return window.realSetItem.call(this,k,v);};},{key:h.key,failure});
 await h.open().click();await page.getByRole('heading',{name:'エラー',exact:true}).waitFor();check((await h.read()).resultJobId===A&&(await h.read()).parsed.items[0].order_quantity===60,failure+': failed save never replaces60m with59m');
 check(await h.card().isVisible()&&!h.calls.some(call=>call==='POST /api/analysis-jobs/'+B+'/seen'),failure+': pending result remains actionable and unacknowledged');await h.context.close();
}
{
 const h=await fixture(bases[0],390),{page}=h;
 await page.evaluate(key=>{window.held=false;void navigator.locks.request(key+':write',()=>new Promise(resolve=>{window.held=true;window.releaseChoiceLock=resolve;}));},h.key);await wait(()=>page.evaluate(()=>window.held));
 await h.open().click();await ui.disclosure(page,'保存済みの結果を開く');await page.getByRole('button',{name:'保存済みの解析結果を探す',exact:true}).click();await page.getByRole('button',{name:'保存済み「Selected C」の結果を確認',exact:true}).click();
 await wait(()=>h.card().innerText().then(text=>text.includes('Selected C')));await page.evaluate(()=>window.releaseChoiceLock());await page.getByRole('heading',{name:'エラー',exact:true}).waitFor();
 check((await h.read()).parsed.items[0].order_quantity===60&&(await h.read()).resultJobId===A,'a different arriving selection invalidates the waiting choice without changing current60m');
 await h.open().click();await wait(()=>h.read().then(d=>d.resultJobId===C));check((await h.read()).parsed.items[0].order_quantity===67&&(await h.read()).resultSiteName==='Selected C','explicitly selecting again opens current C, never the stale59m B');await h.context.close();
}
console.log(JSON.stringify({checks,widths:[320,390],normalBasic:true,synthetic:true,realAI:0,realLINE:0,productionMutations:0}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
