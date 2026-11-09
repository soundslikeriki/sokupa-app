// Exact local production builds; all data, storage, photos, clipboard and API replies are synthetic.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'), assert=require('node:assert/strict');
const ui=require('./result-workspace-helpers.cjs'), bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];
for(const base of bases)assert.equal(new URL(base).hostname,'127.0.0.1');
const job='00000000-0000-4000-8000-00000000000a',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;
const check=(value,label)=>{assert.ok(value,label);console.log('PASS '+(++checks)+': '+label);};
const wait=async fn=>{for(let i=0;i<350;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Quantity policy condition timed out');};
const seed=()=>Array.from({length:6},(_,i)=>({product_code:'SYN-'+String.fromCharCode(65+i),manufacturer:'Synthetic',
 entries:[{source_row_id:'row-'+i,source_image_index:0,source_entry_index:i,original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7,needs_review:true}],
 total_m:50.7,manual_order_quantity:51,order_quantity:51,loss_rate_percent:18,needs_review:true,...(i===0?{quantity_confirmation:'legacy-quantity-flag'}:{})}));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const fixture=async(base,width,kind='plain')=>{
  const owner='synthetic-quantity-policy-'+kind,key='sokupa:workspace:v1:'+owner,items=seed();
  if(kind==='reading')items[0].reading_reviews=[{reason:'Synthetic actual correction to review',candidate_formulas:['1×2'],source_image_index:0}];
  if(kind==='duplicate'){items[1].product_code=items[0].product_code;items[1].manual_order_quantity=items[1].order_quantity=23;}
  if(kind==='unsupported'||kind==='unknown-premise')Object.assign(items[0],{order_mode:'pattern',repeat_cm:60,measurement_basis:kind==='unsupported'?'trim-included':'unconfirmed',pattern_match:kind==='unsupported'?'other':'straight',entries:[{...items[0].entries[0],repeat_enabled:true}]});
  const context=await browser.newContext({viewport:{width,height:844},hasTouch:true}),errors=[],calls=[],unexpected=[];
  await ui.freshResultFixtures(context);
  await context.addInitScript(({key,items,job})=>{
   if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Next synthetic site',resultSiteName:'Displayed synthetic result',resultJobId:job,parsed:{items},originalParsed:{items},orderDraftItems:[]}));
   window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push({text,active:navigator.userActivation.isActive});return Promise.resolve();}}});
  },{key,items,job});
  await context.route('**/*',r=>{
   const req=r.request(),u=new URL(req.url());if(u.origin!==base){unexpected.push(u.origin);return r.abort();}if(!u.pathname.startsWith('/api/'))return r.continue();calls.push({method:req.method(),path:u.pathname});
   if(u.pathname==='/api/auth/session')return r.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
   if(u.pathname==='/api/analysis-jobs'&&req.method()==='GET')return r.fulfill({json:{data:[]}});
   if(u.pathname.endsWith('/seen'))return r.fulfill({json:{success:true}});
   if(u.pathname==='/api/analysis-jobs/'+job)return r.fulfill({json:{data:{id:job,total_images:1}}});
   if(u.pathname==='/api/analysis-jobs/'+job+'/images/0')return r.fulfill({contentType:'image/png',body:png});
   unexpected.push(req.method()+' '+u.pathname);return r.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());await page.goto(base);
  const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key),status=()=>page.getByLabel('SYN-A の発注量チェック',{exact:true}).first();
  const saved=async()=>{let prior='',stable=0;await wait(async()=>{const data=JSON.stringify(await read());stable=data===prior?stable+1:0;prior=data;return stable>=3&&(await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');});};
  const add=()=>page.getByRole('button',{name:/すべて発注リストへ追加/});
  const dialog=()=>page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true}),copy=()=>dialog().getByRole('button',{name:'発注用テキストをコピー',exact:true});
  const open=async()=>{await page.getByRole('button',{name:'確認してコピー',exact:true}).click();await dialog().waitFor();};
  const close=async()=>{await dialog().getByRole('button',{name:'戻る',exact:true}).click();await dialog().waitFor({state:'hidden'});};
  await status().waitFor();await saved();return{context,page,read,status,saved,add,dialog,copy,open,close,errors,calls,unexpected};
 };
 for(const [mode,base]of bases.entries())for(const width of[320,390]){
  {
   const h=await fixture(base,width),{page}=h;
   check((await h.status().innerText()).includes('✅')&&(await h.status().innerText()).includes('必要 50.7m'),'51m is sufficient for50.7m despite raw review flags and60m reserve recommendation');
   check(await h.add().isEnabled(),'overview adds all six numerically valid products without a manual quantity check');
   check((await h.read()).parsed.items[0].quantity_confirmation==='legacy-quantity-flag'&&(await h.read()).parsed.items.slice(1).every(i=>!i.quantity_confirmation),'old flags are retained without fabricating flags for other products');
   await h.open();check(await h.copy().isEnabled()&&await h.dialog().getByRole('checkbox').count()===0,'copy review has no quantity-only acknowledgement or mandatory apply step');
   await h.copy().click();check(await page.evaluate(()=>window.copied.length===1&&window.copied[0].active),'clipboard starts in the final explicit user tap');
   check((await page.evaluate(()=>window.copied[0].text)).includes('数量：51m'),'copied text uses the final manual51m without adding reserve again');await h.close();
   await h.add().click();await wait(()=>h.read().then(d=>d.orderDraftItems.length===6));check((await h.read()).orderDraftItems.every(i=>i.quantity===51),'all-add transfers exactly six final51m quantities');
   await ui.mode(page,'メモ計測');await ui.edit(page,'SYN-A');
   check(await page.getByRole('checkbox',{name:/必要量の前提|メモと発注数量/}).count()===0,'quantity and repeat manual-checkbox UI is removed in both interfaces');
   check(await page.getByLabel('SYN-A の壁の高さ (m)',{exact:true}).isVisible(),'collapse defaults open and common-height input remains direct');
   await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('50');await ui.view(page,'概要');await wait(()=>h.status().innerText().then(t=>t.includes('0.7m不足')));
   check(await h.add().isEnabled(),'exact shortage is advisory; selected50m can still be added');await h.open();check(await h.copy().isEnabled()&&await h.dialog().getByRole('checkbox').count()===0,'shortage copies the chosen amount without any quantity checkbox');await h.close();
   await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('0');await ui.view(page,'概要');check((await h.status().innerText()).includes('50.7m不足'),'zero is a numerical shortage, never sufficient');
   await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('-1');await ui.view(page,'概要');check((await h.status().innerText()).includes('判定不可')&&await h.add().isDisabled(),'negative order input is invalid and preserved, never clamped into a sufficient status');
   await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('');await ui.view(page,'概要');check((await h.status().innerText()).includes('判定不可'),'empty input cannot use the previous quantity as a fallback');
   await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('51');await ui.view(page,'概要');await wait(()=>h.add().isEnabled());check(true,'valid completion re-enables output automatically without quantity acknowledgement');
   await page.reload();await h.status().waitFor();await h.saved();check(await h.add().isEnabled()&&!(await h.read()).parsed.items[0].quantity_confirmation,'reload retains valid quantities after old flag invalidation without generating a replacement flag');
   check(h.errors.length===0&&h.unexpected.length===0,'plain workflow has no errors or real network/API calls');await h.context.close();
  }
  {
   const h=await fixture(base,width,'reading'),{page}=h;
   check((await h.status().innerText()).includes('✅')&&await h.add().isEnabled(),'reading review warnings never hide numerical sufficiency or forbid valid chosen output');
   check((await page.getByLabel('SYN-A の発注時の注意',{exact:true}).innerText()).includes('訂正・取消'),'overview identifies exactly which product needs source review');
   if(process.env.SOKUPA_SCREENSHOT_DIR&&mode===0){await page.getByRole('heading',{name:'必要量との比較（自動）',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:process.env.SOKUPA_SCREENSHOT_DIR+'/quantity-policy-source-review-'+width+'.png'});}
   await h.open();check(await h.dialog().getByRole('checkbox').count()===1&&await h.copy().isEnabled(),'actual reading-risk record is optional and never blocks copy');
   const ack=()=>h.dialog().getByLabel('SYN-A の訂正・取消を照合した',{exact:true});await ack().check();await h.close();await h.saved();check(!(await h.read()).parsed.items[0].reading_review_confirmation&&await h.add().isEnabled(),'Cancel never auto-confirms evidence and valid output remains allowed');
   await h.open();check(!(await ack().isChecked()),'unapplied source check is not retained');await ack().check();await h.dialog().getByRole('button',{name:'照合を記録（任意）',exact:true}).click();await wait(()=>h.copy().isEnabled());await h.saved();
   check((await h.read()).parsed.items[0].reading_review_confirmation&&(await h.read()).parsed.items[0].quantity_confirmation==='legacy-quantity-flag','explicit source review writes only the reading acknowledgement and preserves the old quantity flag');
   await h.close();check(await h.add().isEnabled(),'source review resolves all-add obstruction without an extra repeat/quantity check');
   await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('52');await h.saved();await ui.view(page,'概要');
   check((await h.status().innerText()).includes('✅')&&await h.add().isEnabled(),'editing invalidates optional source fingerprint while valid quantity stays exportable');
   await h.open();check(await h.dialog().getByRole('checkbox').count()===1,'only affected source review is requested again');await ack().check();await h.dialog().getByRole('button',{name:'照合を記録（任意）',exact:true}).click();await h.saved();await h.close();
   await page.reload();await h.status().waitFor();await h.saved();await h.open();check(await h.copy().isEnabled()&&await h.dialog().getByRole('checkbox').count()===0,'saved source review survives reload without a quantity check');await h.close();
   check((await h.read()).orderDraftItems.length===0,'reading review does not silently add products to the draft');
   if(process.env.SOKUPA_SCREENSHOT_DIR&&mode===0){await page.getByRole('heading',{name:'必要量との比較（自動）',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:process.env.SOKUPA_SCREENSHOT_DIR+'/quantity-policy-overview-'+width+'.png'});}
   check(h.errors.length===0&&h.unexpected.length===0,'reading workflow is synthetic and error-free');await h.context.close();
  }
  for(const kind of['duplicate','unsupported','unknown-premise']){
   const h=await fixture(base,width,kind);
   check(kind==='unsupported'?(await h.status().innerText()).includes('判定不可'):(await h.status().innerText()).includes('✅'),kind+': only unsupported arithmetic hides comparison; unconfirmed premises and duplicate identity stay separate');
   check(await h.add().isEnabled(),kind+': valid chosen quantity can be added despite advisory conditions');await h.open();check(await h.copy().isEnabled()&&await h.dialog().getByRole('checkbox').count()===0,kind+': positive quantity can copy without forced checks');await h.close();
   if(kind==='duplicate'){
    const before=(await h.read()).parsed.items.map(i=>i.order_quantity);await ui.edit(h.page,'SYN-A');
    const first=h.page.locator('[data-material-index="0"]'),second=h.page.locator('[data-material-index="1"]');
    await first.getByRole('button',{name:'SYN-A の詳細を省略',exact:true}).click();
    check(await second.getByRole('button',{name:'SYN-A の詳細を省略',exact:true}).isVisible(),'duplicate codes retain independent detail-collapse state');
    await h.page.getByLabel('編集する品番',{exact:true}).selectOption('SYN-A::1');
    check(await first.getByRole('button',{name:'SYN-A の詳細を展開',exact:true}).isVisible()&&await second.isVisible(),'duplicate dropdown selects its distinct material without reopening other collapsed rows');
    const ids=await h.page.locator('[id]').evaluateAll(nodes=>nodes.map(n=>n.id));check(new Set(ids).size===ids.length,'duplicate codes create no duplicate disclosure IDs');
    check(JSON.stringify((await h.read()).parsed.items.map(i=>i.order_quantity))===JSON.stringify(before),'duplicate expansion never merges or changes51m/23m quantities');
    await second.getByRole('button',{name:'SYN-A の発注数量を1m増やす',exact:true}).click();await h.saved();check((await h.read()).parsed.items[0].order_quantity===51&&(await h.read()).parsed.items[1].order_quantity===24,'editing the second duplicate quantity changes23m to24m without changing first51m');
   }
   check(h.errors.length===0&&h.unexpected.length===0,'guard cases are synthetic and error-free');await h.context.close();
  }
 }
 console.log(JSON.stringify({checks,normalAndBasic:true,widths:[320,390],physicalIPhoneSafari:false,realAI:0,realLINE:0,productionMutations:0}));
 }finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});

