// Isolated app flow. The optional image is previewed/uploaded only to intercepted
// localhost APIs; the result below is a human-transcribed fixture, never real OCR.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),ui=require('./result-workspace-helpers.cjs');
const bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];
const job='00000000-0000-4000-8000-000000000e01';
const dimensions=[['TH34707',[[2.7,17],[.8,6]]],['SGM1081',[[2.7,8],[.8,2]]],['TH34114',[[2.7,62],[.6,4],[.7,7]]],['TH34099',[[1.2,8],[2.7,6],[1,12]]],['TH34105',[[2.2,10]]],['TH34486',[[2.7,243],[.7,5],[.8,36]]]];
const payload=process.env.SOKUPA_PROVIDER_RESULT?JSON.parse(fs.readFileSync(process.env.SOKUPA_PROVIDER_RESULT,'utf8')):{items:dimensions.map(([product_code,rows])=>{const total_m=Number(rows.reduce((sum,[l,n])=>sum+l*n,0).toFixed(2));return{product_code,manufacturer:'Synthetic',entries:rows.map(([length_m,quantity],i)=>({source_row_id:product_code+'-'+i,source_image_index:0,original_formula:`${length_m}×${quantity}`,length_m,quantity,subtotal_m:Number((length_m*quantity).toFixed(2))})),total_m,order_quantity:Math.ceil(total_m*1.15),loss_rate_percent:15,needs_review:true,review_reasons:['訂正箇所をメモ画像と照合してください']};})};
const fallback=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
const image=process.env.SOKUPA_MEMO_TEST_IMAGE?fs.readFileSync(process.env.SOKUPA_MEMO_TEST_IMAGE):fallback;
let checks=0;const check=(v,m)=>{assert.ok(v,m);console.log(`PASS ${++checks}: ${m}`);};
const wait=async f=>{for(let i=0;i<350;i++){if(await f())return;await new Promise(r=>setTimeout(r,35));}throw Error('Repeat/reset flow timed out');};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 for(const base of bases)for(const width of[320,390]){
  assert.equal(new URL(base).hostname,'127.0.0.1');
  const owner='synthetic-image-flow',key=`sokupa:workspace:v1:${owner}`,context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),page=await context.newPage();
  const calls=[],blocked=[],errors=[],control={done:false,created:0,uploads:0,cancel:false,hold:false,release:null};
  await context.addInitScript(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied.push(text);}}});});
  // Install interception before any navigation. No credential/session is imported.
  await context.route('**/*',async route=>{const q=route.request(),u=new URL(q.url());if(u.origin!==base){blocked.push(u.origin);return route.abort();}if(!u.pathname.startsWith('/api/'))return route.continue();calls.push({path:u.pathname,method:q.method()});
   if(u.pathname==='/api/auth/session'){if(control.hold)await new Promise(resolve=>control.release=resolve);return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});}
   if(u.pathname==='/api/analysis-jobs'&&q.method()==='GET')return route.fulfill({json:{data:[]}});
   if(u.pathname==='/api/memo-images'&&q.method()==='POST'){control.uploads++;if(process.env.SOKUPA_CAPTURE_UPLOAD){const bytes=q.postDataBuffer(),capture=process.env.SOKUPA_CAPTURE_UPLOAD;if(fs.existsSync(capture))assert.deepEqual(fs.readFileSync(capture),bytes,'repeat previews produce the same captured local upload');else fs.writeFileSync(capture,bytes,{flag:'wx',mode:0o600});}return route.fulfill({json:{object_path:`${owner}/${job}.jpg`}});}
   if(u.pathname==='/api/analysis-jobs'&&q.method()==='POST'){control.created++;check(JSON.parse(q.postData()).site_name==='Synthetic image flow','upload-bound site name stays attached to this synthetic job');return route.fulfill({json:{success:true,job_id:job,background_ready:true,execution_mode:'scheduled-wake'}});}
   if(u.pathname===`/api/analysis-jobs/${job}`)return route.fulfill({json:{data:{id:job,status:control.done?'done':'running',site_name:'Synthetic image flow',result:control.done?payload:null,total_images:1,done_images:control.done?1:0,notification_status:'accepted',can_resume:false,background_ready:true,execution_mode:'scheduled-wake'}}});
   if(u.pathname.endsWith('/seen'))return route.fulfill({json:{success:true}});
   if(u.pathname.endsWith('/images/0'))return route.fulfill({contentType:'image/png',body:fallback});
   throw Error(`Unexpected API blocked: ${q.method()} ${u.pathname}`);
  });
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>control.cancel?d.dismiss():d.accept());
  const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);
  const saved=()=>wait(()=>page.getByLabel('結果の保存状態').innerText().then(t=>t.includes('保存済み')));
  await page.goto(base);await saved();
  await page.evaluate(async()=>{for(const url of['https://sokupa-app.vercel.app/api/analysis-jobs','https://api.line.me/v2/bot/message/push'])try{await fetch(url,{method:'POST',body:'synthetic-isolation-probe'});}catch{}});
  check(blocked.length===2,'production and LINE mutation probes are intercepted before transport');
  await ui.disclosure(page,'画像・現場名');await page.getByRole('region',{name:'メモ計測',exact:true}).getByLabel('現場名（任意）',{exact:true}).fill('Synthetic image flow');
  await page.locator('input[type=file]').setInputFiles({name:process.env.SOKUPA_MEMO_TEST_IMAGE?'provided-test-memo.jpeg':'synthetic.png',mimeType:process.env.SOKUPA_MEMO_TEST_IMAGE?'image/jpeg':'image/png',buffer:image});
  await page.getByAltText('プレビュー 1',{exact:true}).waitFor();await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>Promise.resolve(control.created===1));control.done=true;
  await page.getByLabel('TH34114 の一覧発注数量',{exact:true}).waitFor();await saved();
  check(control.uploads===1&&control.created===1,'one intercepted upload/admission imports one fixture without cloud history');
  check((await read()).parsed.items.find(i=>i.product_code==='TH34099').total_m===37.8,'confirmed corrected1.00×12 is retained, never silently cancelled');
  await ui.edit(page,'TH34114');await page.getByLabel('TH34114 1行目のリピート計算',{exact:true}).click();await page.getByLabel('TH34114 のリピート (cm)',{exact:true}).fill('64.1');await page.getByLabel('TH34114 の壁の高さ (m)',{exact:true}).fill('2.7');await ui.view(page,'概要');await saved();
  const status=()=>page.getByLabel('TH34114 の発注量チェック',{exact:true});await wait(()=>status().innerText().then(t=>t.includes('206.01m')));
  check((await status().innerText()).includes('✅')&&(await read()).parsed.items.find(i=>i.product_code==='TH34114').order_quantity===237,'partial64.1cm repeat compares206.01m against237m excluding15% reserve from the required amount');
  check((await page.getByLabel('TH34114 の計算条件の注意',{exact:true}).innerText()).includes('未確認'),'input comparison keeps unconfirmed construction conditions separate');
  for(const [quantity,expected]of[[206,'0.01m不足'],[207,'✅']]){await ui.edit(page,'TH34114');await page.getByLabel('TH34114 の発注数量を入力',{exact:true}).fill(String(quantity));await ui.view(page,'概要');await wait(()=>status().innerText().then(t=>t.includes(expected)));check(true,`manual${quantity}m updates exact arithmetic status without blocking output`);}
  await ui.edit(page,'TH34114');await page.getByLabel('TH34114 の発注数量を入力',{exact:true}).fill('237');await ui.view(page,'概要');await saved();
  await page.getByRole('button',{name:'すべて発注リストへ追加（6品番）',exact:true}).click();await saved();check((await read()).orderDraftItems.length===6,'overview adds all six valid chosen quantities despite reading notices');
  await ui.mode(page,'発注リスト');await page.getByRole('button',{name:'発注リストをコピー',exact:true}).click();const copied=await page.evaluate(()=>window.copied.at(-1));check(copied.includes('TH34114')&&copied.includes('237')&&!copied.includes('要確認・参考値'),'draft copy keeps chosen quantity without outbound warning annotations');
  await ui.mode(page,'メモ計測');await ui.view(page,'メモ画像');const before=await read();const reset=()=>page.getByRole('button',{name:'すべてリセット',exact:true});
  control.cancel=true;await reset().click();check(JSON.stringify(await read())===JSON.stringify(before),'reset cancellation preserves edited result, list, names and source references');control.cancel=false;
  await reset().click();await wait(()=>read().then(d=>!d.parsed));await saved();let d=await read();check(d.parsed===null&&d.siteName===''&&d.orderDraftItems.length===0&&d.resultSession.undo.parsed.items.find(i=>i.product_code==='TH34114').order_quantity===237,'verified full reset keeps the edited result and entire list in one undo');
  check(await page.getByRole('button',{name:'リセット前の状態を復元',exact:true}).isVisible(),'manual reset stays in the memo-image tab with its separate undo immediately visible');
  await ui.view(page,'概要');check(await page.getByAltText('プレビュー 1',{exact:true}).count()===0&&await page.locator('input[type=file]').inputValue()==='','full reset also clears selected preview and native file input');
  await page.reload();await saved();await ui.view(page,'メモ画像');const restore=page.getByRole('button',{name:'リセット前の状態を復元',exact:true});check(await restore.isEnabled(),'reset undo is available after reload even when the separate recent-draft slot is empty');await restore.click();await wait(()=>read().then(d=>Boolean(d.parsed)));await saved();d=await read();check(d.parsed.items.find(i=>i.product_code==='TH34114').order_quantity===237&&d.siteName===before.siteName&&d.orderDraftItems.length===6&&d.resultJobId===job,'reset restore recovers edited quantities/site/list and original-photo job reference together');
  await ui.view(page,'概要');check((await status().innerText()).includes('206.01m')&&(await status().innerText()).includes('✅'),'reload/restore recomputes the same input arithmetic');
  await page.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key)),item=d.parsed.items.find(i=>i.product_code==='TH34114');item.order_mode='pattern';item.pattern_rows_configured=true;item.pattern_match='other';item.measurement_basis='repeat-adjusted';item.repeat_cm_input='';for(const row of item.entries)row.repeat_enabled=false;localStorage.setItem(key,JSON.stringify(d));},key);
  await page.reload();await saved();check((await status().innerText()).includes('174.7m')&&(await status().innerText()).includes('✅'),'legacy pattern mode with every row OFF compares original lengths without requiring inactive repeat conditions');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile layout stays within viewport');
  check(errors.length===0&&blocked.length===2&&calls.every(c=>!['/api/parse-memo','/api/send-line'].includes(c.path)),'no runtime errors, real AI/LINE calls or unhandled external traffic');
  await context.close();
 }
 console.log(JSON.stringify({checks,realImagePreview:!!process.env.SOKUPA_MEMO_TEST_IMAGE,resultSource:process.env.SOKUPA_PROVIDER_RESULT?'one saved provider OCR response reused; catalog metadata is unknown/fixture':'human-transcribed synthetic fixture, not OCR',realAiCalls:0,realLineSends:0,productionWrites:0}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
