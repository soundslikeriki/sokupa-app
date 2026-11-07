// CSS/layout, real app recovery, and storage checks on production builds; every API is synthetic.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs');
const bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];for(const base of bases)assert.equal(new URL(base).hostname,'127.0.0.1');
const job='00000000-0000-4000-8000-00000000000a',owner='synthetic-copy-review',key=`sokupa:workspace:v1:${owner}`;
const items=Array.from({length:6},(_,i)=>({product_code:`ANON${i+1}`,manufacturer:'Synthetic',entries:[{source_row_id:`r${i}`,source_image_index:i%2,source_entry_index:0,original_formula:`${10+i}×1`,length_m:10+i,quantity:1,subtotal_m:10+i}],total_m:10+i,order_quantity:Math.ceil((10+i)*1.15),reading_reviews:[{reason:i===1?'この品番だけの訂正候補':'共通と同文の注記',candidate_formulas:[`${i+1}×2`],source_image_index:0}]}));
const payload={items,notes:'全体の取消候補 7×2 を原画像で照合してください。'};
let checks=0;const check=(v,label)=>{assert.ok(v,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Built copy review timed out');};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 for(const [mode,base]of bases.entries())for(const width of[320,390]){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[],calls=[],unexpected=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
  await context.addInitScript(({key,payload,job})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed:payload,originalParsed:payload,orderDraftItems:[],resultJobId:job}));window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push({text,active:navigator.userActivation.isActive});return Promise.resolve();}}});},{key,payload,job});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();calls.push({path:u.pathname,method:route.request().method()});
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
   if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
   if(u.pathname===`/api/analysis-jobs/${job}`)return route.fulfill({json:{data:{id:job,total_images:2,status:'done',done_images:2,result:payload,notification_status:'accepted'}}});
   if(u.pathname===`/api/analysis-jobs/${job}/seen`)return route.fulfill({json:{success:true}});
   if(u.pathname.startsWith(`/api/analysis-jobs/${job}/images/`))return route.fulfill({contentType:'image/png',body:png});
   unexpected.push(u.pathname);return route.abort();
  });
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const storage=()=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])));
  const saved=async()=>{await wait(()=>page.getByLabel('結果の保存状態').innerText().then(t=>t.includes('保存済み')));let prev='',n=0;await wait(async()=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));const raw=JSON.stringify(await storage());n=raw===prev?n+1:0;prev=raw;return n>=3;});};
  const dialog=()=>page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true});
  const open=async()=>{await page.getByRole('button',{name:'確認してコピー',exact:true}).click();await dialog().waitFor();};
  const close=async()=>{await dialog().getByRole('button',{name:'戻る',exact:true}).click();await dialog().waitFor({state:'hidden'});};
  const copy=()=>dialog().getByRole('button',{name:'発注用テキストをコピー',exact:true});
  await page.goto(base);await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();await saved();let before=JSON.stringify(await storage());
  const top=()=>page.getByLabel('ANON1 の一覧で訂正・取消と発注数量を確認した',{exact:true});
  check(await top().isEnabled()&&!(await top().isChecked()),'quantity tab exposes an explicit unchecked per-product confirmation');
  check(await top().evaluate(el=>el.closest('label').getBoundingClientRect().height>=44),'list confirmation has a mobile-sized full-row touch target');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'quantity list fits the narrow width with confirmation controls');
  if(process.env.SOKUPA_SCREENSHOT_DIR){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await page.getByRole('heading',{name:'発注内容の確認',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/quantity-confirm-initial-${mode?'basic':'normal'}-${width}.png`,fullPage:false});}
  await page.getByLabel('ANON1 の一覧確認詳細',{exact:true}).locator('summary').first().click();check((await page.getByLabel('ANON1 の一覧確認詳細',{exact:true}).innerText()).includes('候補：1×2'),'collapsed list details retain the exact named correction candidate');
  await page.getByRole('button',{name:'ANON1 の一覧から写真1を確認',exact:true}).click();await page.getByAltText('解析元の写真 1',{exact:true}).waitFor();check((await page.getByAltText('解析元の写真 1',{exact:true}).getAttribute('src')).includes(`${job}/images/0`),'list photo access stays bound to this saved result');await ui.view(page,'数量');await saved();check(JSON.stringify(await storage())===before,'list details/photo navigation never changes saved confirmation or input bytes');
  await top().check();await saved();await wait(()=>read().then(d=>Boolean(d.parsed.items[0].quantity_confirmation&&d.parsed.items[0].reading_review_confirmation)));check((await read()).parsed.items.slice(1).every(i=>!i.quantity_confirmation&&!i.reading_review_confirmation),'direct list check saves only the named product after ordered replan');
  await page.reload();await top().waitFor();await saved();check(await top().isChecked(),'direct list confirmation survives normal reload');await ui.edit(page,'ANON1');check(await page.getByLabel('ANON1 の訂正・取消を確認済みにする',{exact:true}).isChecked()&&await page.getByLabel('ANON1 のメモと発注数量を確認済みにする',{exact:true}).isChecked(),'editor shares the direct list acknowledgements');await ui.view(page,'数量');await open();check(await dialog().getByRole('checkbox').count()===5,'combined screen does not repeat the accepted list confirmation');await close();
  await top().focus();await page.keyboard.press('Space');await saved();await wait(()=>read().then(d=>!d.parsed.items[0].quantity_confirmation&&!d.parsed.items[0].reading_review_confirmation));check(!(await top().isChecked()),'keyboard uncheck clears that product in all three views');before=JSON.stringify(await storage());
  check(await page.getByRole('button',{name:'確認してコピー',exact:true}).isEnabled(),'unconfirmed users have a visible usable entry instead of only a grey copy');await open();
  check(await dialog().getByRole('checkbox').count()===6&&await copy().isDisabled(),'six scoped combined checks and a guarded final copy');
  await wait(()=>dialog().getByRole('button',{name:'写真 2',exact:true}).isVisible());await dialog().getByRole('button',{name:'写真 2',exact:true}).click();
  await dialog().getByLabel('ANON1 の訂正候補と数量を確認した',{exact:true}).check();await close();await saved();check(JSON.stringify(await storage())===before,'Cancel/photo/staging changes no primary draft, latest snapshot or confirmation bytes');
  await open();check(!(await dialog().getByLabel('ANON1 の訂正候補と数量を確認した',{exact:true}).isChecked()),'reopening does not retain unapplied checks');
  check((await dialog().getByRole('region',{name:'ANON2 のコピー前確認',exact:true}).innerText()).includes('この品番だけの訂正候補'),'individual candidate evidence survives global-note presentation');
  check((await dialog().getByRole('region',{name:'ANON1 のコピー前確認',exact:true}).innerText()).includes('7×2'),'global evidence remains scoped to each named product');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'dialog fits mobile width without horizontal overflow');
  check(await copy().evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;}),'final copy stays reachable outside the scroll area');
  await dialog().getByRole('button',{name:'戻る',exact:true}).focus();await page.keyboard.press('Shift+Tab');check(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),'native modal keeps keyboard focus inside');
  if(process.env.SOKUPA_SCREENSHOT_DIR){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await dialog().getByLabel('コピー前の確認内容').evaluate(el=>el.scrollTop=0);await dialog().getByRole('button',{name:'戻る',exact:true}).focus();await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/copy-review-${mode?'basic':'normal'}-${width}.png`,fullPage:false});await dialog().locator('details').first().getByText('元写真（この結果）',{exact:true}).click();await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/copy-review-photo-collapsed-${mode?'basic':'normal'}-${width}.png`,fullPage:false});check(JSON.stringify(await storage())===before,'collapsing source photo changes no saved result or confirmation');}
  for(const checkbox of await dialog().getByRole('checkbox').all())await checkbox.check();await dialog().getByRole('button',{name:'確認を反映',exact:true}).click();
  await wait(()=>copy().isEnabled());await saved();check((await read()).parsed.items.every(i=>i.quantity_confirmation&&i.reading_review_confirmation),'both confirmations persist only after explicit apply and replan');
  check(await page.evaluate(()=>window.copied.length===0),'applying confirmation does not access clipboard');await copy().click();
  check(await page.evaluate(()=>window.copied.length===1&&window.copied[0].active),'separate final tap owns the clipboard operation');
  const text=await page.evaluate(()=>window.copied[0].text);check(items.every(i=>text.includes(i.product_code)&&text.includes(`数量：${i.order_quantity}m`)),'copied list keeps all six original final quantities');
  const confirmed=(await read()).parsed.items.map(i=>({reading:i.reading_review_confirmation,quantity:i.quantity_confirmation}));
  await page.reload();await page.getByRole('button',{name:'確認してコピー',exact:true}).waitFor();await saved();await open();check(await copy().isEnabled()&&await dialog().getByRole('checkbox').count()===0,'reload retains valid confirmations and requires no duplicate checks');
  check(JSON.stringify((await read()).parsed.items.map(i=>({reading:i.reading_review_confirmation,quantity:i.quantity_confirmation})))===JSON.stringify(confirmed),'reload keeps exact accepted fingerprints');await close();
  await ui.edit(page,'ANON1');await page.getByLabel('ANON1 の発注数量を入力',{exact:true}).fill('30');await saved();await ui.view(page,'数量');await open();
  check(await copy().isDisabled()&&await dialog().getByRole('checkbox').count()===1,'editing invalidates only the affected product within the unchanged list');await dialog().getByLabel('ANON1 の訂正候補と数量を確認した',{exact:true}).check();await dialog().getByRole('button',{name:'確認を反映',exact:true}).click();await wait(()=>copy().isEnabled());await saved();await close();
  await ui.edit(page,'ANON1');await page.getByTitle('タップして式を編集').first().click();await page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).fill('');await saved();await ui.view(page,'数量');check(await top().isDisabled()&&!(await top().isChecked()),'incomplete measurement cannot be confirmed from the quantity list');await open();check(await dialog().getByLabel('ANON1 の訂正候補と数量を確認した',{exact:true}).isDisabled()&&await copy().isDisabled(),'incomplete measurement remains blocked in combined flow');
  await page.setViewportSize({width,height:400});check(await copy().evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'short keyboard-sized viewport retains scroll/footer access');
  check(errors.length===0&&unexpected.length===0,'no runtime or unexpected API errors');check(calls.every(c=>c.method==='GET'||c.path.endsWith('/seen')),'no analysis/resume/correction/provider/LINE submission');await context.close();
 }
 console.log(JSON.stringify({checks,widths:[320,390],productionBuilds:2,synthetic:true,realAiCalls:0,realLineSends:0,productionWrites:0}));
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
