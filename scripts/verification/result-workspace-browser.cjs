// Synthetic local-only result workspace. No provider, production DB or LINE request is allowed.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs');
const ui = require('./result-workspace-helpers.cjs');
const bases = [process.env.SOKUPA_TEST_URL, process.env.SOKUPA_BASIC_URL];
for (const base of bases) assert.equal(new URL(base).hostname, '127.0.0.1');
const job = '00000000-0000-4000-8000-00000000000a';
const first = {product_code:'ANON1',manufacturer:'Synthetic',measurement_basis:'trim-included',pattern_match:'straight',repeat_cm:60,entries:[{source_row_id:'r0',source_image_index:0,source_entry_index:0,original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4},{source_row_id:'r1',source_image_index:1,source_entry_index:0,original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8}],total_m:9.2,order_quantity:11};
const payload={items:[first,...[10,15,12,8,30].map((m,i)=>({product_code:`ANON${i+2}`,manufacturer:'Synthetic',entries:[{original_formula:`${m}×1`,length_m:m,quantity:1,subtotal_m:m}],total_m:m,order_quantity:Math.ceil(m*1.15),...(i===0?{reading_reviews:[{reason:'合成の訂正候補を元写真で確認',candidate_formulas:['1×2'],source_image_index:1}]}:{})}))]};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let i=0;i<250;i++){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error('Workspace condition timed out');};
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const errors=[];
 try{for(const base of bases)for(const width of [320,390]){
  const owner=`synthetic-tabs-${width}`,key=`sokupa:workspace:v1:${owner}`,requests=[],photos=[];
  let metadataFails=false,photoFails=false,holdLast=false,lastPhotoRelease=null,photoBytes=png;
  const context=await browser.newContext({viewport:{width,height:844}});
  await context.addInitScript(({key,payload,job})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed:payload,originalParsed:payload,orderDraftItems:[],resultJobId:job}));window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied.push(text)}});},{key,payload,job});
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.origin!==base)throw Error('Non-local request blocked: '+u.origin);
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
   if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
   if(u.pathname===`/api/analysis-jobs/${job}/seen`)return route.fulfill({json:{success:true}});
   if(u.pathname===`/api/analysis-jobs/${job}`)return route.fulfill(metadataFails?{status:503,json:{error:'Synthetic metadata failure'}}:{json:{data:{id:job,total_images:3}}});
   if(u.pathname.startsWith(`/api/analysis-jobs/${job}/images/`)){
    const index=Number(u.pathname.split('/').at(-1));photos.push(index);
    const failThis=photoFails; if(holdLast&&index===2)await new Promise(resolve=>{lastPhotoRelease=resolve;});
    return route.fulfill(failThis?{status:403,json:{error:'Synthetic authorization denial'}}:{contentType:'image/png',headers:{'Cache-Control':'private, no-store'},body:photoBytes});
   }
   if(u.pathname.startsWith('/api/')){requests.push(u.pathname);return route.abort();}
   return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key),saved=()=>wait(()=>page.getByLabel('結果の保存状態').innerText().then(t=>t.includes('保存済み')));
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const copy=()=>page.getByRole('button',{name:'発注用テキストをコピー',exact:true,includeHidden:true});
  await page.goto(base);photoBytes=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=700;const g=c.getContext('2d');g.fillStyle='#fffcf3';g.fillRect(0,0,600,700);g.strokeStyle='#d9e2ef';for(let n=0;n<700;n+=30){g.beginPath();g.moveTo(0,n);g.lineTo(600,n);g.stroke();}g.fillStyle='#15235e';g.font='28px sans-serif';['合成データ・元写真の表示例','ANON1','2.7m × 2','3.8m × 1','リピート 60cm'].forEach((text,n)=>g.fillText(text,40,85+n*95));return c.toDataURL('image/png').split(',')[1];}),'base64');await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).waitFor();await saved();
  check(await tab('数量').getAttribute('aria-selected')==='true','quantity is initial view');
  check(await page.getByRole('tablist').count()===1,'one navigation hierarchy and one result footer');
  check(await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).innerText()==='11m','existing 15% formula is used');
  check(await copy().isDisabled(),'uncertain result cannot copy mockup quantities');
  check((await page.getByLabel('ANON2 の発注量チェック').innerText()).includes('訂正'),'short correction label is visible');
  check(await page.locator('summary').filter({hasText:'画像・現場名'}).locator('..').getAttribute('open')===null,'optional input collapsed while result is shown');
  check(await page.getByRole('heading',{name:'保存済みの解析結果',exact:true}).isHidden(),'optional history is collapsed');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'initial result fits narrow width');
  if(process.env.SOKUPA_SCREENSHOT_DIR){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/tabs-quantity-${base===bases[0]?'normal':'basic'}-${width}.png`,fullPage:false});}
  await page.getByLabel('ANON2 を確認・編集',{exact:true}).click();
  check(await page.getByLabel('編集する品番',{exact:true}).inputValue()==='ANON2','direct edit selects the clicked product');
  check(await page.locator('#material-ANON1').isHidden()&&await page.locator('#material-ANON2').isVisible(),'only selected product editor is visible');
  await ui.edit(page,'ANON1');
  await page.getByLabel('ANON1 に追加する長さ (m)',{exact:true}).fill('1.25');await page.getByLabel('ANON1 に追加する幅数',{exact:true}).fill('3');
  await page.getByTitle('タップして品番を編集').filter({visible:true}).click();await page.getByLabel('品番を編集',{exact:true}).fill('UNCOMMITTED');
  await ui.view(page,'数量');await ui.view(page,'元写真');await page.getByAltText('解析元の写真 1',{exact:true}).waitFor();
  await ui.mode(page,'実寸計測');check(await page.getByRole('heading',{name:'㎡から必要m数を計算'}).isVisible(),'actual-dimension menu preserves existing area calculator');
  await page.locator('#area-sqm').fill('27.5');await page.locator('#area-product-code').fill('AREA-DRAFT');await page.getByLabel('ロス率',{exact:true}).fill('17');await page.locator('#wallpaper-width-mode').selectOption('custom');await page.getByLabel('任意の有効巾',{exact:true}).fill('95.5');
  await ui.mode(page,'発注リスト');await page.getByRole('button',{name:'材料を手動追加',exact:true}).click();await page.locator('#manual-order-code').fill('DRAFT-TEXT');await page.locator('#manual-order-quantity').fill('7.5');
  await ui.mode(page,'メモ計測');await ui.edit(page,'ANON1');
  check(await page.getByLabel('品番を編集',{exact:true}).inputValue()==='UNCOMMITTED'&&(await read()).parsed.items[0].product_code==='ANON1','code draft survives navigation without submission');
  check(await page.getByLabel('ANON1 に追加する長さ (m)',{exact:true}).inputValue()==='1.25'&&await page.getByLabel('ANON1 に追加する幅数',{exact:true}).inputValue()==='3'&&(await read()).parsed.items[0].entries.length===2,'unadded row survives all tabs and modes without calculation');
  if(base===bases[0]){await page.getByRole('button',{name:'ANON1 明細1の写真を確認',exact:true}).click();await ui.edit(page,'ANON1');check(await page.getByLabel('品番を編集',{exact:true}).inputValue()==='UNCOMMITTED'&&(await read()).parsed.items[0].product_code==='ANON1','direct source-photo navigation does not commit a code draft');}
  await page.getByLabel('品番を編集',{exact:true}).press('Escape');
  await ui.mode(page,'実寸計測');check(await page.locator('#area-sqm').inputValue()==='27.5'&&await page.getByLabel('任意の有効巾',{exact:true}).inputValue()==='95.5'&&await page.locator('#area-product-code').inputValue()==='AREA-DRAFT'&&await page.getByLabel('ロス率',{exact:true}).inputValue()==='17','area inputs survive mode switches without lookup');
  await ui.mode(page,'発注リスト');check(await page.locator('#manual-order-code').inputValue()==='DRAFT-TEXT'&&await page.locator('#manual-order-quantity').inputValue()==='7.5','manual order draft text survives modes');
  await page.getByRole('button',{name:'発注リストに追加',exact:true}).click();await wait(()=>read().then(d=>d.orderDraftItems.length===1));
  const addDuplicate=async()=>{await page.getByRole('button',{name:'材料を手動追加',exact:true}).click();await page.locator('#manual-order-code').fill('DRAFT-TEXT');await page.locator('#manual-order-quantity').fill('2');await page.getByRole('button',{name:'発注リストに追加',exact:true}).click();await page.getByText('DRAFTTEXT はすでに発注リストにあります',{exact:true}).waitFor();};
  await addDuplicate();await ui.mode(page,'実寸計測');await ui.mode(page,'発注リスト');check(await page.getByText('DRAFTTEXT はすでに発注リストにあります',{exact:true}).isVisible()&&(await read()).orderDraftItems.length===1,'pending duplicate survives modes without adding or merging');
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();check((await read()).orderDraftItems.length===1,'duplicate cancel leaves original quantity intact');
  await addDuplicate();await page.getByRole('button',{name:'合算する',exact:true}).click();await wait(()=>read().then(d=>d.orderDraftItems[0].quantity===9.5));check((await read()).orderDraftItems.length===1,'duplicate merge preserves reviewed unit and sum');
  await addDuplicate();await page.getByRole('button',{name:'別項目で追加',exact:true}).click();await wait(()=>read().then(d=>d.orderDraftItems.length===2));check((await read()).orderDraftItems.map(item=>item.quantity).join(',')==='9.5,2','duplicate separate keeps independent quantities');
  await ui.mode(page,'メモ計測');await ui.edit(page,'ANON1');
  await page.getByTitle('タップして式を編集').filter({visible:true}).first().click();await page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).fill('');await saved();
  for(const name of ['数量','元写真','編集・リピート'])await ui.view(page,name);
  check(await page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).inputValue()===''&&await copy().isDisabled(),'blank measurement survives views and blocks copy');
  await ui.view(page,'数量');check(await page.getByLabel('ANON1 の一覧発注数量',{exact:true}).innerText()==='未確定','blank measurement is never presented as a final old number');
  await ui.edit(page,'ANON1');await page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).fill('2.7');await wait(()=>read().then(d=>d.parsed.items[0].entries[0].length_input===undefined&&d.parsed.items[0].entries[0].length_m===2.7));await saved();
  const total=()=>read().then(d=>d.parsed.items[0].total_m);
  check(await page.getByLabel('ANON1 1行目の長さ (m)',{exact:true}).evaluate(el=>el===document.activeElement),'length input stays focused immediately before one row-toggle click');
  await page.getByLabel('ANON1 1行目のリピート計算',{exact:true}).click();await wait(async()=>await total()===9.8).catch(async error=>{console.log('SYNTHETIC_REPEAT_DIAGNOSTIC',JSON.stringify((await read()).parsed.items[0]));throw error;});check((await read()).parsed.items[0].order_quantity===12,'partial repeat retains 9.8m and 12m order');
  await page.getByRole('switch',{name:'ANON1 の一括リピート計算',exact:true}).click();await wait(async()=>await total()===10.2);check((await read()).parsed.items[0].order_quantity===12,'master ON retains two heights and 10.2m');
  if(process.env.SOKUPA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/tabs-editor-${base===bases[0]?'normal':'basic'}-${width}.png`,fullPage:false});
  await page.getByRole('switch',{name:'ANON1 の一括リピート計算',exact:true}).click();await wait(async()=>await total()===9.2);await saved();check((await read()).parsed.items[0].order_quantity===11,'master OFF restores 9.2m once');
  await page.getByRole('button',{name:'幅数を追加',exact:true}).click();await wait(()=>read().then(d=>d.parsed.items[0].entries.length===3));await saved();
  await page.reload();await ui.edit(page,'ANON1');await saved();check((await read()).parsed.items[0].entries.length===3&&(await read()).originalParsed.items[0].entries.length===2,'explicitly added row restores once and original rows remain');
  // Current photo failures and late old images cannot discard the editor or replace another selected image.
  metadataFails=true;await ui.view(page,'元写真');await page.getByRole('button',{name:'写真一覧を再取得',exact:true}).waitFor();check(await page.getByRole('alert').filter({hasText:'元写真の一覧'}).isVisible(),'metadata failure gives a reachable retry');
  metadataFails=false;await page.getByRole('button',{name:'写真一覧を再取得',exact:true}).click();await page.getByAltText('解析元の写真 1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'写真 2',exact:true}).click();check((await page.getByAltText('解析元の写真 2',{exact:true}).getAttribute('src')).includes(`${job}/images/1`),'photo always uses displayed result job and selected index');
  await wait(()=>page.getByAltText('解析元の写真 2',{exact:true}).evaluate(img=>img.complete&&img.naturalWidth>0));
  // A new image avoids treating a decoded in-memory image as a fresh HTTP failure.
  holdLast=true;photoFails=true;await page.getByRole('button',{name:'写真 3',exact:true}).click();await wait(()=>lastPhotoRelease!==null);await page.getByRole('button',{name:'写真 2',exact:true}).click();lastPhotoRelease();holdLast=false;photoFails=false;
  await wait(()=>page.getByAltText('解析元の写真 2',{exact:true}).evaluate(img=>img.complete&&img.naturalWidth>0));check(await page.getByAltText('解析元の写真 2',{exact:true}).isVisible()&&await page.getByRole('button',{name:'写真を再取得',exact:true}).count()===0,'late old photo cannot replace selected photo or attach its error');
  if(process.env.SOKUPA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/tabs-photo-${base===bases[0]?'normal':'basic'}-${width}.png`,fullPage:false});
  await page.keyboard.press('Escape');check(await tab('数量').getAttribute('aria-selected')==='true','Escape returns safely to quantities');
  await tab('数量').focus();await page.keyboard.press('ArrowRight');await wait(async()=>await tab('編集・リピート').getAttribute('aria-selected')==='true'&&await tab('編集・リピート').evaluate(el=>el===document.activeElement));check(await tab('編集・リピート').getAttribute('aria-selected')==='true'&&await tab('編集・リピート').evaluate(el=>el===document.activeElement),'keyboard tabs set selection and focus');
  await ui.view(page,'元写真');await page.goBack();check(await tab('編集・リピート').getAttribute('aria-selected')==='true','Back follows view history without a reload');
  await page.getByRole('button',{name:'計測・発注メニュー',exact:true}).click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');check(await page.getByRole('button',{name:'計測・発注メニュー',exact:true}).getAttribute('aria-expanded')==='false'&&await page.getByRole('button',{name:'計測・発注メニュー',exact:true}).evaluate(el=>el===document.activeElement),'menu Escape closes and restores trigger focus');
  // Quota/snapshot failures stay actionable in the other calculator, too.
  await page.evaluate(()=>{window.realStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(':latest-result:'))throw new DOMException('Synthetic quota','QuotaExceededError');return window.realStorageSet.call(this,k,v);};});
  await page.getByLabel('ANON1 の発注数量を入力',{exact:true}).fill('25');await page.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).waitFor();await ui.mode(page,'実寸計測');
  check(await page.getByRole('button',{name:'保存できない現在の内容を書き出す',exact:true}).isVisible(),'save failure export is outside hidden result modes');
  await page.evaluate(()=>{Storage.prototype.setItem=window.realStorageSet;});await ui.mode(page,'メモ計測');
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>250});window.visualViewport.dispatchEvent(new Event('resize'));});await wait(()=>page.getByRole('tablist').isHidden());check(true,'software-keyboard-sized viewport hides fixed footer');await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});await wait(()=>page.getByRole('tablist').isVisible());
  await page.setViewportSize({width:844,height:390});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'landscape has no horizontal overflow');
  await page.setViewportSize({width,height:844});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'portrait has no horizontal overflow');
  const footer=await page.getByRole('tablist').boundingBox();check(footer.y+footer.height<=844&&footer.height>=56,'single footer sits within viewport and includes content padding');
  check(photos.every(index=>[0,1,2].includes(index))&&requests.length===0,'navigation never uploads, analyses, looks up, corrects codes or sends LINE');
  await context.close();
 }
 check(errors.length===0,'no browser runtime errors: '+errors.join(';'));
 console.log(JSON.stringify({checks,synthetic:true,realAiCalls:0,realLineSends:0,productionMutations:0}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
