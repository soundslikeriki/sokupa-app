// Regression for the independent review: synthetic APIs, no remote requests or real images.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const ui = require('./result-workspace-helpers.cjs');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3318';
const a='00000000-0000-4000-8000-00000000000a', b='00000000-0000-4000-8000-00000000000b';
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const wait=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error('Regression condition timed out');};
const memo=code=>({items:[{product_code:code,manufacturer:'Synthetic',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23}]});
const browserOptions={executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true};
async function setup(browser,name,initial,handler){
 const owner=`synthetic-review-${name}`,key=`sokupa:workspace:v1:${owner}`,latestKey=`sokupa:latest-result:v1:${owner}`;
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 await ui.freshResultFixtures(context);
 page.on('dialog',dialog=>dialog.dismiss());page.on('pageerror',error=>{throw error;});
 const draft={version:1,siteName:'Original A',parsed:initial,originalParsed:initial,orderDraftItems:[],resultJobId:a};
 await context.addInitScript(({key,draft})=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem(key,JSON.stringify(draft));sessionStorage.setItem('seeded','yes');}},{key,draft});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner}});
  if(handler&&await handler(route,u,owner))return;
  if(u.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:[]}});
  if(u.pathname.endsWith('/seen')||u.pathname.endsWith('/resume'))return route.fulfill({json:{success:true}});
  if(u.pathname.startsWith('/api/'))throw Error('Unexpected synthetic API '+u.pathname);
  return route.continue();
 });
 const saved=()=>wait(()=>page.getByLabel('結果の保存状態').innerText().then(s=>s.includes('保存済み')));
 const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);
 const upload=async()=>{await ui.disclosure(page,'画像・現場名');const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();};
 await page.goto(base);await ui.edit(page,initial.items[0].product_code);await saved();
 return {context,page,key,latestKey,saved,read,upload};
}
async function uploadEdit(browser){
 let release,waiting=false,created=false,done=false;const gate=new Promise(r=>release=r);
 const h=await setup(browser,'upload',memo('A'),async(route,u,owner)=>{
  if(u.pathname==='/api/memo-images'){waiting=true;await gate;await route.fulfill({json:{object_path:`${owner}/${b}.jpg`}});return true;}
  if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='POST'){created=true;await route.fulfill({json:{success:true,job_id:b,background_ready:true,execution_mode:'scheduled-wake'}});return true;}
  if(u.pathname===`/api/analysis-jobs/${b}`){await route.fulfill({json:{data:{id:b,status:done?'done':'running',site_name:'Server B',result:done?memo('B'):null,total_images:1,done_images:done?1:0,notification_status:'accepted',can_resume:false,background_ready:true,execution_mode:'scheduled-wake'}}});return true;}
  return false;
 });
 try{const {page,saved,read}=h;await h.upload();await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>waiting);
  await page.getByLabel('現場名（任意）',{exact:true}).first().fill('Edit during upload');await wait(()=>read().then(d=>d.siteName==='Edit during upload'));await saved();check((await read()).siteName==='Edit during upload','upload-time edit is saved before reception');
  release();await wait(()=>created);await page.getByText('解析を受け付けました',{exact:true}).waitFor();done=true;await page.getByText('別の解析結果があります',{exact:true}).waitFor();
  check((await read()).resultJobId===a&&(await read()).siteName==='Edit during upload','completion never silently replaces upload-time edits');
  await page.reload();await page.getByText('別の解析結果があります',{exact:true}).waitFor();check((await read()).siteName==='Edit during upload','replacement conflict and edits survive reload');
  await page.getByRole('button',{name:'最新1件に上書きして開く（今の結果と置換）',exact:true}).click();await ui.edit(page,'B');await saved();check((await read()).resultJobId===b,'only explicit replacement opens B');
 }finally{release();await h.context.close();}
}
async function incompleteMeasurements(browser){
 const h=await setup(browser,'blank',memo('CHECK'));
 try{const {page,saved,read}=h;const confirm=page.getByLabel('CHECK のメモと発注数量を確認済みにする',{exact:true});
  await confirm.check();await wait(()=>read().then(d=>Boolean(d.parsed.items[0].quantity_confirmation)));
  for(const field of ['length','quantity']){
   await page.getByTitle('タップして式を編集').first().click();const label=field==='length'?'CHECK 1行目の長さ (m)':'CHECK 1行目の幅数';const prop=field==='length'?'length_input':'quantity_input';
   await page.getByLabel(label,{exact:true}).fill('');await wait(()=>read().then(d=>d.parsed.items[0].entries[0][prop]===''));await saved();
   check(!(await page.getByLabel('CHECK の発注量チェック').getAttribute('class')).includes('text-emerald-')&&!(await page.getByLabel('CHECK の発注量チェック').innerText()).includes('確認済み'),'blank '+field+' has no green or confirmed status');check(!(await confirm.isChecked()),'blank '+field+' invalidates confirmation');
   check(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true}).isDisabled(),'blank '+field+' cannot be copied');check(await page.getByRole('button',{name:'発注リストに追加',exact:true}).isDisabled(),'blank '+field+' cannot be transferred');
   check((await read()).parsed.items[0].entries[0][prop]==='','blank '+field+' stored independently from last valid number');
   check(await page.evaluate(({k,prop})=>JSON.parse(localStorage.getItem(k)).latest.snapshot.parsed.items[0].entries[0][prop]==='',{k:h.latestKey,prop}),'latest snapshot retains blank '+field);
   await page.reload();await ui.edit(page,'CHECK');await page.getByTitle('タップして式を編集').first().click();check(await page.getByLabel(label,{exact:true}).inputValue()==='','blank '+field+' restores after reload');
   await page.getByLabel(label,{exact:true}).fill(field==='length'?'20':'1');await saved();check(!(await confirm.isChecked()),'completing '+field+' does not silently reconfirm');
   await confirm.check();await wait(()=>read().then(d=>Boolean(d.parsed.items[0].quantity_confirmation)));checks++;
  }
 }finally{await h.context.close();}
}
async function resetAfterDelete(browser,provenance){
 const initial=memo('ROWS');initial.items[0].entries=[{original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4},{original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8}].map((e,i)=>provenance?{...e,source_row_id:`image-${i}:row-0`,source_image_index:i,source_entry_index:0}:e);
 const h=await setup(browser,provenance?'reset-source':'reset-legacy',initial);
 try{const {page,read,saved}=h;await page.getByRole('button',{name:'この数式を削除',exact:true}).first().click();await wait(()=>read().then(d=>d.parsed.items[0].entries.length===1));
  for(let attempt=0;attempt<2;attempt++){
   if(attempt){await page.reload();await ui.edit(page,'ROWS');}
   await page.getByTitle('タップして式を編集').first().click();await page.getByLabel('ROWS 1行目の長さ (m)',{exact:true}).fill('9');await page.getByLabel('ROWS 1行目の幅数',{exact:true}).fill('7');await saved();
   await page.getByTitle('この行の編集を元に戻す').click();await wait(()=>read().then(d=>d.parsed.items[0].entries[0].length_m===3.8));await saved();const entry=(await read()).parsed.items[0].entries[0];
   check(entry.length_m===3.8&&entry.quantity===1,'reset restores surviving row, including after reload');
   if(provenance)check(entry.source_row_id==='image-1:row-0'&&entry.source_image_index===1,'reset retains the same source photo identity');
  }
 }finally{await h.context.close();}
}
async function intakeLock(browser){
 let uploads=0,attempts=0,accepted=0;
 const h=await setup(browser,'lock',memo('A'),async(route,u,owner)=>{
  if(u.pathname==='/api/memo-images'){uploads++;await route.fulfill({json:{object_path:`${owner}/${a}.jpg`}});return true;}
  if(u.pathname==='/api/analysis-jobs'){
   if(route.request().method()==='POST'){attempts++;if(attempts===1)await route.fulfill({status:503,json:{error:'Synthetic temporary admission failure'}});else{accepted++;await route.fulfill({json:{success:true,job_id:'00000000-0000-4000-8000-00000000000c',background_ready:true,execution_mode:'scheduled-wake'}});}return true;}
   await route.fulfill({json:{data:[{id:b,status:'done',notification_status:'accepted'}]}});return true;
  }
  if(u.pathname===`/api/analysis-jobs/${b}`){await route.fulfill({json:{data:{id:b,status:'done',result:memo('B'),notification_status:'accepted',total_images:1,done_images:1,background_ready:true,execution_mode:'scheduled-wake'}}});return true;}
  if(u.pathname.endsWith('/00000000-0000-4000-8000-00000000000c')){await route.fulfill({json:{data:{id:'00000000-0000-4000-8000-00000000000c',status:'running',total_images:1,done_images:0,notification_status:'pending',background_ready:true,execution_mode:'scheduled-wake'}}});return true;}
  return false;
 });
 try{const {page}=h;await page.getByText('別の解析結果があります',{exact:true}).waitFor();await h.upload();
  await page.evaluate(key=>{const gate=new Promise(resolve=>window.releaseReviewLock=resolve);void navigator.locks.request(`${key}:write`,{mode:'exclusive'},async()=>{window.reviewLockHeld=true;await gate;});},h.key);await page.waitForFunction(()=>window.reviewLockHeld);
  const button=await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).elementHandle();await button.evaluate(el=>{el.click();el.click();});
  await wait(()=>button.isDisabled());check(uploads===0&&attempts===0,'lock wait disables intake before any upload/request');
  await page.evaluate(()=>window.releaseReviewLock());await wait(()=>attempts===1);await wait(()=>button.isEnabled());check(uploads===1&&accepted===0,'double click creates exactly one failed admission attempt');
  check((await h.read()).resultJobId===a,'failed admission preserves current A');await page.getByText('別の解析結果があります',{exact:true}).waitFor();checks++;
  await button.click();await wait(()=>accepted===1);await page.getByText('解析を受け付けました',{exact:true}).waitFor();check(attempts===2&&uploads===2,'failure releases the guard for one deliberate retry');
 }finally{await h.page.evaluate(()=>window.releaseReviewLock?.()).catch(()=>{});await h.context.close();}
}
(async()=>{const browser=await chromium.launch(browserOptions);try{await uploadEdit(browser);await incompleteMeasurements(browser);await resetAfterDelete(browser,true);await resetAfterDelete(browser,false);await intakeLock(browser);console.log(JSON.stringify({checks,uploadEditPreserved:true,incompleteMeasurements:true,stableReset:true,singleIntake:true,realAiCalls:0,realLineSends:0}));}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
