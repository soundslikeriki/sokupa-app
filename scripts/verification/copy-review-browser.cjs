// Native dialog and actual OrderList. All data and API responses are synthetic.
const { chromium }=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const bundle=fs.readFileSync(process.env.SOKUPA_COPY_REVIEW_BUNDLE,'utf8'),origin='http://127.0.0.1:18900';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
const make=(n=6)=>Array.from({length:n},(_,i)=>({product_code:`SYN-${String.fromCharCode(65+i)}`,manufacturer:'Synthetic',entries:[{source_row_id:`r${i}`,source_image_index:i%2,source_entry_index:0,original_formula:`${20+i}×1`,length_m:20+i,quantity:1,subtotal_m:20+i}],total_m:20+i,order_quantity:Math.ceil((20+i)*1.15),reading_reviews:[{reason:'同じ文の訂正候補',candidate_formulas:[`${i+1}×2`],source_image_index:0}]}));
let checks=0;const check=(v,label)=>{assert.ok(v,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Copy review timed out');};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try {
 const fixture=async({basic=false,profile='default',seed=make(),confirmed=false,holdMetadata=false,failMetadata=false,holdImage=false,imageStatus=200}={})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],unexpected=[],imageRequests=[];let releaseImage=null;
  await context.route('**/*',async route=>{const u=new URL(route.request().url());
   if(u.origin===origin&&u.pathname==='/harness')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
   if(u.origin===origin&&/^\/api\/analysis-jobs\/.+\/images\/\d+$/.test(u.pathname)){
    imageRequests.push(u.pathname);if(holdImage&&u.pathname.includes('000a/'))await new Promise(resolve=>{releaseImage=resolve;});
    const status=holdImage&&u.pathname.includes('000a/')?404:imageStatus;
    try{return await route.fulfill({status,contentType:status===200?'image/png':'application/json',body:status===200?png:'{"error":"Synthetic photo refusal"}'});}catch{return;}
   }
   unexpected.push(u.origin+u.pathname);return route.abort();
  });
  await page.addInitScript(({seed,basic,profile,confirmed,holdMetadata,failMetadata})=>{
   window.seed=seed;window.basic=basic;window.confirmed=confirmed;window.holdMetadata=holdMetadata;window.failMetadata=failMetadata;window.copied=[];
   Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push({text,active:navigator.userActivation.isActive});return window.copyFail?Promise.reject(Error('Synthetic clipboard denial')):Promise.resolve();}}});
   if(profile==='ancestor')document.addEventListener('focusout',e=>{if(e.target instanceof HTMLInputElement)Object.defineProperty(e,'relatedTarget',{value:document.getElementById('root')});},true);
   if(profile!=='default')document.addEventListener('mousedown',e=>{if(e.target.closest('[data-workspace-navigation]')){e.preventDefault();document.activeElement.blur();}},true);
  },{seed,basic,profile,confirmed,holdMetadata,failMetadata});
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());await page.goto(origin+'/harness');await page.addScriptTag({content:bundle});
  const dialog=()=>page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true}),copy=()=>dialog().getByRole('button',{name:'発注用テキストをコピー',exact:true});
  const open=async()=>{await page.getByRole('tab',{name:'概要',exact:true}).click();await page.getByRole('button',{name:'確認してコピー',exact:true}).click();await dialog().waitFor();};
  const close=async()=>{await dialog().getByRole('button',{name:'戻る',exact:true}).click();await dialog().waitFor({state:'hidden'});};
  const read=()=>page.evaluate(()=>({items:window.items,calls:window.calls,copied:window.copied}));
  const ack=(code='SYN-A')=>dialog().getByLabel(`${code} の訂正・取消を照合した`,{exact:true});
  const status=(code='SYN-A')=>page.getByLabel(`${code} の発注量チェック`,{exact:true});
  const details=(code='SYN-A')=>page.getByLabel(`${code} の一覧確認詳細`,{exact:true});
  const apply=()=>dialog().getByRole('button',{name:'照合を記録（任意）',exact:true});
  const all=async()=>{for(const checkbox of await dialog().getByRole('checkbox').all())if(await checkbox.isEnabled())await checkbox.check();await apply().click();await wait(()=>copy().isEnabled());};
  await wait(()=>read().then(r=>r.items.every(item=>item.memo_allowance!==undefined&&item.loss_rate_percent!==undefined)));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  return {context,page,dialog,copy,open,close,read,ack,status,details,apply,all,errors,unexpected,imageRequests,repairImage:()=>{imageStatus=200;},release:()=>releaseImage?.()};
 };
 for(const basic of[false,true]){
  const h=await fixture({basic,seed:make(2)}),{page}=h;
  check(await page.getByRole('tabpanel').filter({visible:true}).getByRole('checkbox').count()===0,'overview has numerical status instead of manual acknowledgement controls');
  const before=JSON.stringify((await h.read()).items);await h.details().locator('summary').first().click();
  check((await h.details().innerText()).includes('対象：SYN-A')&&(await h.details().innerText()).includes('候補：1×2'),'list disclosure preserves exact target/candidate');
  await h.details().getByRole('button',{name:'SYN-A の一覧から写真1を確認',exact:true}).click();await page.getByAltText('解析元の写真 1',{exact:true}).waitFor();await page.getByRole('tab',{name:'概要',exact:true}).click();
  check(JSON.stringify((await h.read()).items)===before,'numerical/photo viewing never acknowledges or edits quantities');
  await h.open();await h.ack().check();await h.apply().click();await wait(()=>h.read().then(r=>Boolean(r.items[0].reading_review_confirmation&&!r.items[0].quantity_confirmation)));await h.close();
  check(!(await h.read()).items[1].reading_review_confirmation&&!(await h.read()).items[1].quantity_confirmation,'explicit A review never confirms B with the same note');
  check((await h.read()).items[0].order_quantity===23&&(await h.read()).copied.length===0,'explicit confirmation changes no quantity and never copies');
  await page.getByRole('button',{name:'SYN-A を確認・編集',exact:true}).click();check(await page.getByLabel('SYN-A の訂正・取消を確認済みにする',{exact:true}).isChecked(),'dialog/editor state stays consistent');
  await h.open();check(await h.ack().count()===0&&await h.ack('SYN-B').count()===1,'valid acknowledgement is reused without duplicate checking');await h.close();
  await page.getByRole('button',{name:'SYN-A の発注数量を1m増やす',exact:true}).click();await wait(()=>h.read().then(r=>r.items[0].order_quantity===24&&!r.items[0].reading_review_confirmation));await h.open();check(await h.ack().count()===1&&await h.copy().isEnabled(),'quantity change preserves24m and invalidates the optional review record without blocking copy');
  check(h.errors.length===0&&h.unexpected.length===0&&(await h.read()).calls.every(c=>c.method==='GET'),'overview/review uses only synthetic reads');await h.context.close();
 }
 for(const kind of['job','site','add','remove','duplicate','image','code']){
  const h=await fixture({seed:make(2),confirmed:true});await h.page.evaluate(kind=>window.change(kind),kind);await wait(()=>h.read().then(r=>!r.items[0].reading_review_confirmation));check((await h.read()).items[0].order_quantity===23,`${kind}: closed overview scope change preserves amounts and invalidates prior acknowledgement`);await h.open();check(await h.copy().isEnabled(),`${kind}: scope change invalidates optional records but permits current valid output`);await h.context.close();
 }
 for(const basic of [false,true]){
  const h=await fixture({basic}),{page}=h;await h.open();check(await h.dialog().getByRole('checkbox').count()===6,'six products retain six explicitly scoped combined confirmations');
  check(await h.copy().isEnabled()&&(await h.read()).copied.length===0,'opening review never copies or confirms');
  for(const code of ['SYN-A','SYN-B','SYN-C','SYN-D','SYN-E','SYN-F'])check(await h.dialog().getByRole('region',{name:`${code} のコピー前確認`,exact:true}).isVisible(),`${code} has its own candidates and quantity`);
  await wait(()=>h.dialog().getByRole('button',{name:'写真 2',exact:true}).isVisible());await h.dialog().getByRole('button',{name:'写真 2',exact:true}).click();
  check((await h.dialog().getByAltText('解析元の写真 2',{exact:true}).getAttribute('src')).endsWith('/images/1'),'multiple photos stay in the same review screen');
  check((await h.read()).items.every(i=>!i.reading_review_confirmation&&!i.quantity_confirmation),'photo viewing never acknowledges any product');
  await h.ack().check();check((await h.read()).items.every(i=>!i.quantity_confirmation),'staged check does not write acknowledgements');await h.close();await h.open();check(!(await h.ack().isChecked()),'Cancel discards unapplied checks');
  await h.ack().check();await page.goBack();await h.dialog().waitFor({state:'hidden'});await page.goForward();await h.dialog().waitFor();check(!(await h.ack().isChecked()),'Back/Forward starts a fresh confirmation session');await page.keyboard.press('Escape');await h.dialog().waitFor({state:'hidden'});await h.open();
  await h.all();await wait(()=>h.read().then(r=>r.items.every(i=>i.reading_review_confirmation&&!i.quantity_confirmation)));check((await h.read()).items.every(i=>i.reading_review_confirmation&&!i.quantity_confirmation),'apply writes only explicit source review, never a quantity flag');check((await h.read()).copied.length===0,'apply never implicitly copies');
  await h.copy().click();let result=await h.read();check(result.copied.length===1&&result.copied[0].active,'separate explicit copy starts under user activation');check(result.items.every(i=>result.copied[0].text.includes(i.product_code)&&result.copied[0].text.includes(`数量：${i.order_quantity}m`)),'all six final amounts serialize unchanged');
  const preserved=JSON.stringify(result.items);await h.close();await h.open();check(await h.dialog().getByRole('checkbox').count()===0&&await h.copy().isEnabled(),'valid existing acknowledgements require no repeated checks');check(JSON.stringify((await h.read()).items)===preserved,'reopening preserves existing confirmations');
  await page.evaluate(()=>window.copyFail=true);await h.copy().click();await h.dialog().getByRole('alert').waitFor();check((await h.read()).items.every(i=>i.reading_review_confirmation)&&await h.copy().isEnabled(),'clipboard failure preserves reviewed values for explicit retry');await page.evaluate(()=>window.copyFail=false);
  await page.evaluate(()=>window.change('quantity'));await wait(()=>h.ack().isVisible());check(await h.copy().isEnabled(),'changed numbers invalidate optional record without blocking copy');await h.ack().check();await page.evaluate(()=>window.change('candidate'));await wait(()=>h.ack().isVisible().then(async v=>v&&!(await h.ack().isChecked())));check(await h.apply().isDisabled(),'changed candidates reject an earlier staged token');
  await h.ack().check();await h.apply().click();await wait(()=>h.copy().isEnabled());await page.evaluate(()=>window.change('job'));await wait(()=>h.dialog().getByRole('checkbox').count().then(n=>n===6));check(await h.copy().isEnabled(),'changed photo job cannot inherit earlier in-session confirmation even with equal numeric fingerprints');
  check((await h.read()).calls.every(c=>c.method==='GET')&&h.errors.length===0&&h.unexpected.length===0,'only synthetic metadata reads; no correction/job/provider/LINE call');await h.context.close();
 }
 for(const kind of ['add','remove','duplicate','site','image','code']){
  const h=await fixture({seed:make(2),confirmed:true});await h.open();check(await h.copy().isEnabled(),`${kind}: initial matching confirmations are preserved`);
  await h.page.evaluate(kind=>window.change(kind),kind);await wait(()=>h.read().then(r=>!r.items[0].reading_review_confirmation));
  check(await h.dialog().getByRole('checkbox').count()>0,`${kind}: changed result/list identity invalidates the prior optional records`);
  check((await h.read()).items[0].order_quantity===23&&(await h.read()).items[0].entries[0].length_m===20,`${kind}: scope invalidation keeps the actual quantity and dimensions`);
  if(kind==='duplicate')check(await h.dialog().getByRole('checkbox',{disabled:true}).count()===2,'duplicate product codes cannot share a confirmation');
  await h.close();await h.open();check(await h.copy().isEnabled(),`${kind}: Cancel/reopen never records a stale acknowledgement; current quantities still copy`);await h.context.close();
 }
 {
  const h=await fixture({seed:make(1)});await h.open();await h.ack().check();await h.page.evaluate(()=>window.change('candidate'));await wait(()=>h.ack().isChecked().then(v=>!v));await h.page.evaluate(()=>window.change('restore'));await wait(()=>h.dialog().getByText('同じ文の訂正候補',{exact:true}).isVisible());check(!(await h.ack().isChecked())&&await h.apply().isDisabled(),'content change then revert never revives an earlier unapplied acknowledgement');await h.context.close();
 }
 for(const kind of ['blank','shortage','unknown','other','adjusted','invalid-setting']){
  const seed=make(1);if(kind==='blank')seed[0].entries[0].length_input='';if(kind==='shortage')seed[0].manual_order_quantity=1;
  if(['unknown','other','adjusted','invalid-setting'].includes(kind)){Object.assign(seed[0],{order_mode:'pattern',repeat_cm:60,measurement_basis:kind==='adjusted'?'repeat-adjusted':kind==='unknown'?'unconfirmed':'trim-included',pattern_match:kind==='other'?'other':'straight'});seed[0].entries[0].repeat_enabled=true;}
  if(kind==='invalid-setting')seed[0].repeat_height_input='-1';const h=await fixture({seed});check((await h.status().innerText()).includes(kind==='shortage'?'不足':'判定不可'),`${kind}: numeric shortage/unknown remains separate from output`);await h.open();check((kind==='shortage'?await h.ack().isEnabled():await h.ack().isDisabled())&&await h.copy().isEnabled(),`${kind}: optional record eligibility never gates the positive chosen quantity`);check(!(await h.read()).items[0].quantity_confirmation,`${kind} remains unconfirmed`);await h.context.close();
 }
 {
  const h=await fixture({seed:make(1),confirmed:true,holdMetadata:true});await h.open();check(await h.copy().isEnabled(),'existing confirmation survives pending photo metadata');await h.copy().click();check((await h.read()).copied.length===1&&(await h.read()).copied[0].active,'copy does not await metadata/image communication');await h.context.close();
 }
 {
  const h=await fixture({seed:make(1),holdImage:true});await h.open();await wait(()=>h.imageRequests.length>0);await h.page.evaluate(()=>window.change('job'));await wait(()=>h.dialog().getByAltText('解析元の写真 1',{exact:true}).getAttribute('src').then(src=>src?.includes('000b/')));h.release();check(!(await h.dialog().getByText('写真を取得できませんでした。通信とログイン状態を確認してください。',{exact:true}).isVisible()),'late prior-job image error cannot mark current photo failed');check((await h.dialog().getByAltText('解析元の写真 1',{exact:true}).getAttribute('src')).includes('000b/images/0'),'photo index/URL bind to changed displayed job');await h.context.close();
 }
 {
  const h=await fixture({seed:make(1),holdMetadata:true});await h.open();await wait(()=>h.read().then(r=>r.calls.length>0));await h.page.evaluate(()=>window.change('job'));await wait(()=>h.dialog().getByAltText('解析元の写真 1',{exact:true}).getAttribute('src').then(src=>src?.includes('000b/')));await h.page.evaluate(()=>window.releaseMetadata());check(await h.dialog().getByRole('button',{name:'写真 2',exact:true}).count()===0,'late old-job metadata cannot replace the current job image count');await h.context.close();
 }
 {
  const h=await fixture({seed:make(1),failMetadata:true});await h.open();await h.dialog().getByText('メモ画像の一覧を取得できませんでした。結果と編集は保持しています。',{exact:true}).waitFor();check((await h.read()).items[0].order_quantity===23&&!(await h.read()).items[0].quantity_confirmation,'metadata refusal keeps quantities and never confirms');await h.page.evaluate(()=>window.failMetadata=false);await h.dialog().getByRole('button',{name:'写真一覧を再取得',exact:true}).click();await h.dialog().getByAltText('解析元の写真 1',{exact:true}).waitFor();check((await h.dialog().getByAltText('解析元の写真 1',{exact:true}).getAttribute('src')).includes('000a/images/0'),'metadata retry stays tied to the displayed job');await h.context.close();
 }
 for(const imageStatus of[403,404]){
  const h=await fixture({seed:make(1),imageStatus});await h.open();await h.dialog().getByText('写真を取得できませんでした。通信とログイン状態を確認してください。',{exact:true}).waitFor();check((await h.read()).items[0].order_quantity===23&&!(await h.read()).items[0].quantity_confirmation,`${imageStatus}: photo failure preserves quantities without confirmation`);h.repairImage();await h.dialog().getByRole('button',{name:'写真を再取得',exact:true}).click();await h.dialog().getByAltText('解析元の写真 1',{exact:true}).waitFor();check((await h.dialog().getByAltText('解析元の写真 1',{exact:true}).getAttribute('src')).includes('000a/images/0'),`${imageStatus}: photo retry cannot switch job or image`);await h.context.close();
 }
 for(const basic of [false,true])for(const profile of ['default','null','ancestor']){
  const h=await fixture({basic,profile,seed:make(1)}),{page}=h;await page.getByRole('tab',{name:'数量',exact:true}).click();await page.getByTitle('タップして品番を編集',{exact:true}).click();await page.getByLabel('品番を編集',{exact:true}).fill('UNCOMMITTED');await h.open();check((await h.read()).items[0].product_code==='SYN-A'&&(await h.read()).calls.every(c=>c.method==='GET'),`${profile}/${basic}: opening review never commits pending code`);await h.close();check(await page.getByRole('tabpanel').filter({visible:true}).getByRole('checkbox').count()===0&&(await h.read()).items[0].product_code==='SYN-A',`${profile}/${basic}: overview status cannot commit or confirm a hidden draft`);await page.getByRole('tab',{name:'数量',exact:true}).click();check(await page.getByLabel('品番を編集',{exact:true}).inputValue()==='UNCOMMITTED',`${profile}/${basic}: Cancel preserves code draft`);await h.context.close();
 }
 console.log(JSON.stringify({checks,synthetic:true,normalBasic:true,physicalSafari:false,realProviderCalls:0,realLineSends:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
