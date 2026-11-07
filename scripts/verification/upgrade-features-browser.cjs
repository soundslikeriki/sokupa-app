const workspace = require('./result-workspace-helpers.cjs');
// Integrated UI on a local Next server; every API/provider response is synthetic.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SOKUPA_TEST_URL || 'http://127.0.0.1:3318', owner = 'synthetic-upgrade';
const key = `sokupa:workspace:v1:${owner}`, latestKey = `sokupa:latest-result:v1:${owner}`;
const a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b',c='00000000-0000-4000-8000-00000000000c';
const entries = [{source_row_id:'image-0:row-0',source_image_index:0,source_entry_index:0,original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4},{source_row_id:'image-1:row-0',source_image_index:1,source_entry_index:0,original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8}];
const initial = { items:[{product_code:'HEIGHT',manufacturer:'Synthetic',entries,total_m:9.2,order_quantity:11}] };
const fresh = { items:[{product_code:'HEIGHT',manufacturer:'Synthetic',entries:[{source_row_id:'image-0:row-0',source_image_index:0,source_entry_index:0,original_formula:'2.5×1',length_m:2.5,quantity:1,subtotal_m:2.5}],total_m:2.5,order_quantity:3}] };
const last = { items:[{...fresh.items[0],product_code:'FINAL',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23}] };
let checks=0; const check=(ok,message)=>{assert.ok(ok,message);checks++;};
const wait=async(fn)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,80));}throw Error('Integrated UI condition timed out');};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();let created=0,doneB=false,doneC=false,photos=0;
 page.on('pageerror',error=>{throw error;});
 await context.addInitScript(({key,initial,a})=>{if(!sessionStorage.getItem('seeded')&&!localStorage.getItem(key)){localStorage.setItem(key,JSON.stringify({version:1,siteName:'Original site',parsed:initial,originalParsed:initial,orderDraftItems:[],resultJobId:a}));sessionStorage.setItem('seeded','yes');}},{key,initial,a});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
  if(url.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner}});
  if(url.pathname==='/api/memo-images')return route.fulfill({json:{object_path:`${owner}/${a}.jpg`}});
  if(url.pathname==='/api/analysis-jobs'){
   if(route.request().method()==='POST'){created++;return route.fulfill({json:{success:true,job_id:created===1?b:c,background_ready:true,execution_mode:'scheduled-wake'}});}
   return route.fulfill({json:{data:[]}});
  }
  if(/\/images\/[01]$/.test(url.pathname)){photos++;return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64')});}
  if(url.pathname.startsWith('/api/analysis-jobs/')){
   if(url.pathname.endsWith('/seen')||url.pathname.endsWith('/resume'))return route.fulfill({json:{success:true}});
   const id=url.pathname.split('/').pop(),done=id===a||(id===b?doneB:doneC);
   return route.fulfill({json:{data:{id,status:done?'done':'running',site_name:id===a?'Original site':'Next site',result:id===a?initial:id===b?fresh:last,total_images:id===a?2:1,done_images:done?(id===a?2:1):0,notification_status:'accepted',can_resume:false,background_ready:true,execution_mode:'scheduled-wake'}}});
  }
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{data:null}});return route.continue();
 });
 const saved=()=>wait(()=>page.getByLabel('結果の保存状態').innerText().then(text=>text.includes('保存済み')));
 const draft=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
 const noArchives=()=>page.evaluate(key=>Object.keys(localStorage).filter(k=>k.startsWith(`${key}:recovery:`)).length,key);
 await page.goto(base);await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();
 check((await page.getByLabel('HEIGHT の発注量チェック').innerText()).includes('数量を確認') && !(await page.getByLabel('HEIGHT の発注量チェック').getAttribute('class')).includes('emerald'),'unchecked conditions never show green');
 check(await page.getByText('数量を確認',{exact:true}).first().isVisible(),'product badge never claims unconfirmed inputs are proven');
 await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT のメモと発注数量を確認済みにする',{exact:true}).check();
 await wait(()=>page.getByLabel('HEIGHT の発注量チェック').innerText().then(text=>text.includes('確認済み')));checks++;
 await workspace.view(page, '数量'); await page.getByRole('button',{name:'HEIGHT の発注数量を1m減らす',exact:true}).first().click();await workspace.view(page, '数量'); await page.getByRole('button',{name:'HEIGHT の発注数量を1m減らす',exact:true}).first().click();
 await wait(()=>page.getByLabel('HEIGHT の発注量チェック').innerText().then(text=>text.includes('必要量に不足')));
 await workspace.edit(page, 'HEIGHT'); await page.locator('fieldset details').last().locator('summary').click();
 await wait(()=>page.getByRole('status').filter({hasText:'0.2m'}).count().then(n=>n>0));checks++;
 await workspace.view(page, '数量'); await page.getByRole('button',{name:'HEIGHT の発注数量を1m増やす',exact:true}).first().click();
 await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT のメモと発注数量を確認済みにする',{exact:true}).check();
 await wait(()=>page.getByLabel('HEIGHT の発注量チェック').innerText().then(text=>text.includes('確認済み')));checks++;
 await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).fill('');await saved();
 check((await page.getByLabel('HEIGHT の発注量チェック').innerText()).includes('入力未完了'),'blank quantity is not silently treated as zero');
 check(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true}).isDisabled(),'incomplete quantity cannot be copied');
 check(await page.getByRole('button',{name:'発注リストに追加',exact:true}).isDisabled(),'incomplete quantity cannot be transferred to the order draft');
 await page.reload();await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();check(await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).inputValue()==='','incomplete editor input survives reload');
 await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).fill('10');await saved();
 await page.getByRole('switch',{name:'HEIGHT の一括リピート計算',exact:true}).click();
 await page.getByLabel('HEIGHT の寸法区分',{exact:true}).selectOption('trim-included');
 await page.getByLabel('HEIGHT のリピート (cm)',{exact:true}).fill('60');
 await wait(()=>draft().then(d=>d.parsed.items[0].total_m===10.2));checks++;
 check(!(await page.getByLabel('HEIGHT の必要量の前提を確認済みにする',{exact:true}).isChecked()),'repeat change invalidates old confirmation');
 await page.getByLabel('HEIGHT の柄合わせ方式',{exact:true}).selectOption('straight');await page.getByLabel('HEIGHT の必要量の前提を確認済みにする',{exact:true}).check();await saved();
 check((await page.getByLabel('HEIGHT の無地と柄比較').innerText()).includes('9.2m ／ 柄合わせ 10.2m'),'plain and pattern totals compare without flattening heights');
 check((await draft()).parsed.items[0].entries[0].length_m===2.7&&(await draft()).parsed.items[0].entries[1].length_m===3.8,'source heights remain intact');
 if(process.env.SOKUPA_SCREENSHOT){await page.screenshot({path:process.env.SOKUPA_SCREENSHOT,fullPage:true});if(process.env.SOKUPA_VISUAL_ONLY==='1'){console.log(JSON.stringify({visualOnly:true,checks,viewport:390}));return;}}
 await page.getByRole('button',{name:'HEIGHT 明細2の写真を確認',exact:true}).click();await page.getByAltText('解析元の写真 2',{exact:true}).waitFor();check(photos===1,'correct source image is requested through owner API');
 await page.reload();await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();check(await page.getByLabel('HEIGHT の必要量の前提を確認済みにする',{exact:true}).isChecked(),'confirmation and repeat edits restore for the same inputs');
 await page.getByRole('switch',{name:'HEIGHT の一括リピート計算'}).click();await wait(()=>draft().then(d=>d.parsed.items[0].total_m===9.2));checks++;
 check(!(await page.getByLabel('HEIGHT のメモと発注数量を確認済みにする',{exact:true}).isChecked()),'OFF resets confirmation and restores original lengths');await saved();
 await page.evaluate(key=>localStorage.removeItem(key),key);await page.reload();await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();check((await draft()).parsed.items[0].total_m===9.2,'fixed latest snapshot recovers a missing primary');
 const upload=async()=>{const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=4;return canvas.toDataURL('image/png').split(',')[1];});await workspace.disclosure(page, '画像・現場名'); await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();};
 await upload();await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>created===1);check((await draft()).resultJobId===a,'previous result persists while the next analysis runs');await workspace.view(page, '元写真');await page.getByRole('button',{name:'写真 2',exact:true}).click();await page.getByAltText('解析元の写真 2',{exact:true}).waitFor();check((await page.getByAltText('解析元の写真 2',{exact:true}).getAttribute('src')).includes(a+'/images/1'),'queued newer analysis and selected upload never substitute for displayed original photo');
 await page.reload();await workspace.edit(page, 'HEIGHT'); await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();check((await draft()).resultJobId===a,'last result restores while accepted background work is pending');doneB=true;
 await wait(()=>draft().then(d=>d.resultJobId===b));await saved();check((await draft()).parsed.items[0].order_quantity===3,'same product in a new job does not inherit previous overrides');check(await page.locator('summary').filter({hasText:'画像・現場名'}).locator('..').getAttribute('open')===null,'new result collapses retained upload controls without deleting selected images');check((await noArchives())===0,'normal next-upload replacement creates no history keys');
 await upload();await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>created===2);
 await workspace.disclosure(page, '画像・現場名'); await page.getByLabel('現場名（任意）',{exact:true}).first().fill('Edit during analysis');await saved();doneC=true;
 await page.getByText('別の解析結果があります',{exact:true}).waitFor();check((await draft()).siteName==='Edit during analysis','editing during analysis is never silently replaced');
 await page.getByRole('button',{name:'最新1件に上書きして開く（今の結果と置換）',exact:true}).click();await workspace.edit(page, 'FINAL'); await page.getByLabel('FINAL の発注数量を入力',{exact:true}).waitFor();await saved();check((await noArchives())===0,'explicit overwrite uses the same fixed slots');
 const backup=await page.evaluate(key=>localStorage.getItem(key),latestKey);check(Boolean(backup),'latest replacement is backed up');
 await page.evaluate(key=>localStorage.setItem(key,'broken-json-kept'),key);await page.reload();await page.getByRole('button',{name:'最新の保存結果から復元（元データは退避）',exact:true}).click();await workspace.edit(page, 'FINAL'); await page.getByLabel('FINAL の発注数量を入力',{exact:true}).waitFor();await saved();
 check(await page.evaluate(key=>Object.keys(localStorage).some(k=>k.startsWith(`${key}:recovery:`)&&localStorage.getItem(k)==='broken-json-kept'),key),'corrupt original bytes remain available after explicit recovery');
 const other=await context.newPage();await other.goto(base);await workspace.edit(other, 'FINAL'); await other.getByLabel('FINAL の発注数量を入力',{exact:true}).waitFor();await wait(()=>other.getByLabel('結果の保存状態').innerText().then(text=>text.includes('保存済み')));
 await workspace.disclosure(page, '画像・現場名'); await page.getByLabel('現場名（任意）',{exact:true}).first().fill('Tab one saved');await saved();
 await workspace.disclosure(other, '画像・現場名'); await other.getByLabel('現場名（任意）',{exact:true}).first().fill('Tab two stale');await other.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).waitFor();
 check((await draft()).siteName==='Tab one saved','stale tab cannot overwrite the newer primary');
 check(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).latest.snapshot.context.siteName,latestKey)==='Tab one saved','stale tab cannot overwrite the latest snapshot');await other.close();
 await page.evaluate(key=>{window.beforeSnapshotQuota=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Synthetic snapshot quota','QuotaExceededError');return window.beforeSnapshotQuota.call(this,k,v);};},latestKey);
 await workspace.disclosure(page, '画像・現場名'); await page.getByLabel('現場名（任意）',{exact:true}).first().fill('Primary survives backup quota');await page.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).waitFor();
 check((await draft()).siteName==='Primary survives backup quota','backup failure does not lose the primary edit');
 await page.evaluate(()=>{Storage.prototype.setItem=window.beforeSnapshotQuota;});await page.reload();await workspace.edit(page, 'FINAL'); await page.getByLabel('FINAL の発注数量を入力',{exact:true}).waitFor();await saved();
 await page.evaluate(key=>localStorage.setItem(key,'broken-snapshot-preserved'),latestKey);await page.reload();await page.getByRole('button',{name:'復元用保存を再作成（元の保存は退避）',exact:true}).waitFor();
 check((await draft()).siteName==='Primary survives backup quota','valid primary restores despite snapshot corruption');
 await page.getByRole('button',{name:'復元用保存を再作成（元の保存は退避）',exact:true}).click();await saved();
 check(await page.evaluate(key=>localStorage.getItem(`${key}:unreadable`),latestKey)==='broken-snapshot-preserved','explicit repair preserves corrupt snapshot bytes');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile UI has no horizontal overflow');
 console.log(JSON.stringify({checks,integratedRepeatQuantityLatestRecovery:true,sourcePhoto:true,realAiCalls:0,realLineSends:0}));
 await context.close();
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1});
