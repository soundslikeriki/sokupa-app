// Actual OrderList/menu, with controlled non-focusing-button profiles. Not physical Safari.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const bundle=fs.readFileSync(process.env.SOKUPA_FOCUS_BUNDLE,'utf8');
let checks=0;const results=[];const check=(v,m)=>{assert.ok(v,m);console.log(`PASS ${++checks}: ${m}`);};
const wait=async fn=>{for(let n=0;n<250;n++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Focus boundary timed out');};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const fixture=async(profile,basic)=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],unexpected=[];
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin==='http://127.0.0.1:18899'&&u.pathname==='/focus-harness')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});if(u.origin==='http://127.0.0.1:18899'&&/\/api\/analysis-jobs\/[^/]+\/images\/[01]$/.test(u.pathname))return route.fulfill({contentType:'image/png',body:png});unexpected.push(u.origin+u.pathname);return route.abort();});
  await page.addInitScript(({profile,basic})=>{
   window.basic=basic;window.blurs=[];
   document.addEventListener('focusout',event=>{if(profile==='ancestor'&&event.target instanceof HTMLInputElement)Object.defineProperty(event,'relatedTarget',{value:document.getElementById('root')});window.blurs.push({target:event.target.getAttribute?.('aria-label'),related:event.relatedTarget?.tagName??null});},true);
   if(profile!=='default')document.addEventListener('mousedown',event=>{if(event.target.closest('[data-workspace-navigation],[data-preserve-editor-input]')){event.preventDefault();document.activeElement.blur();}},true);
  },{profile,basic});
  page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:18899/focus-harness');await page.addScriptTag({content:bundle});await page.getByRole('tab',{name:'数量',exact:true}).click();
  const input=()=>page.getByLabel('品番を編集',{exact:true}),read=()=>page.evaluate(()=>({code:window.items[0].product_code,item:window.items[0],posts:window.calls.filter(call=>call.url==='/api/memo-corrections'&&call.method==='POST').length,blurs:window.blurs}));
  const begin=async value=>{await page.getByTitle('タップして品番を編集',{exact:true}).filter({visible:true}).click();await input().fill(value);};
  return {context,page,input,read,begin,errors,unexpected};
 };
 for(const basic of [false,true])for(const profile of ['default','null','ancestor']){
  for(const target of ['tab','menu-trigger','menu-choice','source-photo','repeat-controls','material-details','repeat-details','condition-shortcut','calculation-explanation','reading-details','copy-review']){
   const h=await fixture(profile,basic),{page}=h;if(target==='source-photo'&&basic)await page.getByLabel('SYNA の個別照合詳細',{exact:true}).locator(':scope > summary').click();if(['repeat-details','condition-shortcut','calculation-explanation','reading-details','copy-review'].includes(target))await page.getByLabel('SYNA 1行目のリピート計算',{exact:true}).click();await h.begin('UNCOMMITTED');check(await h.input().evaluate(el=>el===document.activeElement),`${profile}/${basic}/${target}: code input focused before direct navigation`);
   if(target==='tab')await page.getByRole('tab',{name:'概要',exact:true}).click();
   if(target==='repeat-controls'){
    const before=await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0}));const toggle=page.getByRole('button',{name:'SYNA の数量・リピート',exact:true});await toggle.click();const after=await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0}));check(JSON.stringify(before)===JSON.stringify(after),'disclosure does not emit a meaningful edit or change item fingerprints');
    check(await toggle.getAttribute('aria-expanded')==='false',`${profile}/${basic}: one direct click collapses repeat controls`);
   }
   if(target==='material-details'){const before=await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0}));await page.getByRole('button',{name:'SYNA の詳細を省略',exact:true}).click();await page.getByRole('button',{name:'SYNA の詳細を展開',exact:true}).click();check(JSON.stringify(await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0})))===JSON.stringify(before),'whole-material collapse preserves input and meaningful-edit state');}
   if(target==='repeat-details')await page.getByLabel('SYNA の詳細設定・確認',{exact:true}).click();
   if(target==='condition-shortcut')await page.getByLabel('SYNA のリピート条件を確認',{exact:true}).click();
   if(target==='reading-details')await page.getByLabel('SYNA の個別照合詳細',{exact:true}).locator(':scope > summary').click();
   if(target==='copy-review'){await page.getByRole('button',{name:'SYNA の確認画面を開く',exact:true}).click();await page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true}).getByRole('button',{name:'戻る',exact:true}).click();await page.getByRole('dialog',{name:'発注内容を確認してコピー',exact:true}).waitFor({state:'hidden'});}
   if(target==='calculation-explanation')await page.getByLabel('SYNA の計算説明',{exact:true}).locator('summary').click();
   if(target.startsWith('menu')){await page.getByRole('button',{name:'計測・発注メニュー',exact:true}).click();if(target==='menu-choice')await page.getByRole('group',{name:'既存機能へ切り替え'}).getByRole('button',{name:/実寸計測/}).click();else await page.keyboard.press('Escape');}
   if(target==='source-photo')await page.getByRole('button',{name:basic?'SYNA の訂正候補の写真 1を確認':'SYNA 明細1の写真を確認',exact:true}).click();
   check((await h.read()).code==='SYNA'&&(await h.read()).posts===0,`${profile}/${basic}/${target}: one navigation never commits or posts`);
   if(target==='menu-choice'){await page.getByRole('button',{name:'計測・発注メニュー',exact:true}).click();await page.getByRole('group',{name:'既存機能へ切り替え'}).getByRole('button',{name:/メモ計測/}).click();}
   await page.getByRole('tab',{name:'数量',exact:true}).click();check(await h.input().inputValue()==='UNCOMMITTED',`${profile}/${basic}/${target}: pending code text returns intact`);
   await h.input().press('Escape');check((await h.read()).code==='SYNA'&&(await h.read()).posts===0,`${profile}/${basic}/${target}: explicit cancel remains safe`);
   const result=await h.read();if(profile!=='default')check(result.blurs.some(blur=>profile==='null'?blur.related===null:blur.related==='DIV'),`${profile}: requested relatedTarget profile actually occurred`);
   check(h.errors.length===0&&h.unexpected.length===0,'no runtime error or real backend request');results.push({profile,basic,target,...result});await h.context.close();
  }
  // Enter, intentional non-navigation blur, canceled gesture and expiry still save.
  {
   const h=await fixture(profile,basic),{page}=h;await h.begin('ENTER-SAVED');await h.input().press('Enter');await wait(()=>h.read().then(r=>r.code==='ENTERSAVED')).catch(async error=>{console.log('SYNTHETIC_ENTER_DIAGNOSTIC',JSON.stringify(await h.read()));throw error;});check((await h.read()).posts===1,`${profile}/${basic}: Enter saves exactly once`);
   await h.begin('CANCELLED');await h.input().press('Escape');check((await h.read()).code==='ENTERSAVED'&&(await h.read()).posts===1,'Escape never saves a canceled draft');
   await h.begin('ORDINARY-BLUR');await page.getByLabel('ENTERSAVED のロス率を入力',{exact:true}).click();await wait(()=>h.read().then(r=>r.code==='ORDINARYBLUR'));check((await h.read()).posts===2,'intentional non-navigation blur still saves once');
   await h.begin('POINTER-CANCEL');const tab=page.getByRole('tab',{name:'概要',exact:true});await tab.dispatchEvent('pointerdown');await tab.dispatchEvent('pointercancel');await h.input().evaluate(el=>el.blur());await wait(()=>h.read().then(r=>r.code==='POINTERCANCEL'));check((await h.read()).posts===3,'pointercancel clears navigation intent before a later blur');
   await h.begin('GESTURE-ENDED');await tab.dispatchEvent('pointerdown');await tab.dispatchEvent('pointerup');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));await h.input().evaluate(el=>el.blur());await wait(()=>h.read().then(r=>r.code==='GESTUREENDED'));check((await h.read()).posts===4,'ended/canceled click intent expires and does not suppress a later save');
   check(h.errors.length===0&&h.unexpected.length===0,'save/cancel tests make only stub correction calls');await h.context.close();
  }
  {
   const h=await fixture(profile,basic),{page}=h;await page.getByTitle('タップして式を編集').filter({visible:true}).first().click();const length=page.getByLabel('SYNA 1行目の長さ (m)',{exact:true});await length.fill('');await wait(()=>h.read().then(r=>r.item.entries[0].length_input===''));check(await length.evaluate(el=>el===document.activeElement),'raw empty edit is reflected while numeric input remains focused before one collapse click');const beforeCollapse=await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0}));const repeatToggle=page.getByRole('button',{name:'SYNA の数量・リピート',exact:true});await repeatToggle.click();await repeatToggle.click();const afterCollapse=await page.evaluate(()=>({item:JSON.stringify(window.items),edits:window.meaningfulEdits??0}));if(JSON.stringify(beforeCollapse)!==JSON.stringify(afterCollapse)||await length.inputValue()!=='')console.log('SYNTHETIC_COLLAPSE_DIAGNOSTIC',JSON.stringify({profile,basic,beforeCollapse,afterCollapse,value:await length.inputValue()}));check(JSON.stringify(beforeCollapse)===JSON.stringify(afterCollapse)&&await length.inputValue()==='','focused blank row survives direct collapse/expand with no implicit commit, including non-focusing profiles');await page.getByRole('tab',{name:'概要',exact:true}).click();await page.getByRole('tab',{name:'数量',exact:true}).click();check(await length.inputValue()===''&&(await h.read()).item.entries[0].length_input==='','raw blank row survives null/ancestor navigation');await length.fill('2.7');check(await length.evaluate(el=>el===document.activeElement),'numeric input focused immediately before one repeat click');
   await page.getByLabel('SYNA 1行目のリピート計算',{exact:true}).click();await wait(()=>h.read().then(r=>r.item.total_m===9.8));const result=await h.read();check(result.item.entries[0].repeat_enabled&&result.item.entries[0].length_m===2.7&&result.item.entries[1].length_m===3.8&&result.item.order_quantity===12,'one direct repeat click applies 9.8m/12m without flattening heights');check(await length.inputValue()==='2.7'&&result.posts===0,'row draft/editor survives and no correction is posted');check(h.errors.length===0&&h.unexpected.length===0,'numeric profile has no real backend request');await h.context.close();
  }
 }
 for(const behavior of ['delay','http-failure','network-failure']) {
   const h=await fixture('default',false),{page}=h;
   await page.getByLabel('SYNA に追加する長さ (m)',{exact:true}).fill('1.25');
   await page.evaluate(mode=>{window.holdCorrection=mode==='delay';window.correctionStatus=mode==='http-failure'?503:0;window.failCorrection=mode==='network-failure';},behavior);
   await h.begin('SAVED-ONE');await h.input().press('Enter');await wait(()=>h.read().then(r=>r.code==='SAVEDONE'));
   check((await h.read()).posts===1&&h.errors.length===0,`${behavior}: Enter preserves new code with one POST and no React error`);
   check(await page.getByLabel('SAVEDONE に追加する長さ (m)',{exact:true}).inputValue()==='1.25','existing unadded-row draft follows the explicitly edited code');
   await page.getByRole('tab',{name:'概要',exact:true}).click();await page.getByRole('tab',{name:'メモ画像',exact:true}).click();await page.getByRole('tab',{name:'数量',exact:true}).click();
   check((await h.read()).code==='SAVEDONE'&&(await h.read()).posts===1,`${behavior}: tab navigation cannot replay or revert local code edit`);
   if(behavior==='delay') {const next=(await h.read()).item;next.product_code='NEWJOB';await page.evaluate(next=>window.replaceResult('00000000-0000-4000-8000-00000000000b',[next]),next);await page.getByRole('tab',{name:'概要',exact:true}).waitFor();await page.evaluate(()=>window.releaseCorrection());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));check((await h.read()).code==='NEWJOB'&&(await h.read()).posts===1,'late correction response cannot modify a different result job');}
   check(h.errors.length===0&&h.unexpected.length===0,'delayed/failure fixture has only synthetic requests');await h.context.close();
 }
 console.log(JSON.stringify({checks,synthetic:true,profiles:['default Chrome','simulated relatedTarget=null','simulated ancestor relatedTarget'],physicalSafariTested:false,realBackendRequests:0,realAiCalls:0,realLineSends:0,results}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
