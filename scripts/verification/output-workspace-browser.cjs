// Latest advisory-only output policy and multi-material UI. All inputs/APIs/clipboard are synthetic.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./result-workspace-helpers.cjs'),bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL];
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Output workspace condition timed out');};
const product=(code,i)=>({product_code:code,manufacturer:'Synthetic',entries:[{source_row_id:'r'+i,source_image_index:0,source_entry_index:i,original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7}],total_m:50.7,manual_order_quantity:51,order_quantity:51,loss_rate_percent:18});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
for(const [mode,base]of bases.entries())for(const width of[320,390]){
 assert.equal(new URL(base).hostname,'127.0.0.1');
 const owner=`synthetic-output-workspace-${width}`,key='sokupa:workspace:v1:'+owner,items=['SYN-A','SYN-B','SYN-C'].map(product),errors=[],unexpected=[],calls=[];
 items[0].reading_reviews=[{reason:'この品番の訂正候補',candidate_formulas:['1×2'],source_image_index:0}];
 items[1].entries[0].needs_review=true;items[1].entries[0].review_reason='画像：一部の文字を読み取れませんでした';
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true});await ui.freshResultFixtures(context);
 await context.addInitScript(({key,items,A})=>{
  if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Next C',resultSiteName:'Source A',resultJobId:A,parsed:{items},originalParsed:{items},orderDraftItems:[{id:'draft-existing',productCode:'DRAFT',quantity:23,unit:'m',sourceType:'manual',sourceLabel:'手動'}]}));
  window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push({text,active:navigator.userActivation.isActive});return Promise.resolve();}}});
 },{key,items,A});
 await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==base){unexpected.push(u.origin);return route.abort();}if(!u.pathname.startsWith('/api/'))return route.continue();calls.push(req.method()+' '+u.pathname);
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
  if(u.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:u.searchParams.has('history')?[null,'','  ','Result B','現場名なし'].map((site_name,index)=>({id:index===3?B:'history-'+index,site_name,status:'done',created_at:'2026-11-08T00:00:00Z'})):[]}});
  if(u.pathname===`/api/analysis-jobs/${A}`)return route.fulfill({json:{data:{id:A,total_images:1}}});
  if(u.pathname===`/api/analysis-jobs/${B}`)return route.fulfill({json:{data:{id:B,status:'done',site_name:'Result B',total_images:1,done_images:1,notification_status:'accepted',result:{items:[product('OTHER-B',0)]}}}});
  if(u.pathname.endsWith('/seen'))return route.fulfill({json:{success:true}});
  if(u.pathname.endsWith('/images/0'))return route.fulfill({contentType:'image/png',body:png});
  unexpected.push(req.method()+' '+u.pathname);return route.abort();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
 const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key),saved=async()=>{let prior='',stable=0;await wait(async()=>{const bytes=JSON.stringify(await read());stable=bytes===prior?stable+1:0;prior=bytes;return stable>=3&&(await page.getByLabel('結果の保存状態').innerText()).includes('保存済み');});};
 const card=i=>page.locator(`[data-material-index="${i}"]`),status=()=>page.getByLabel('SYN-A の発注量チェック',{exact:true});
 await page.goto(base);await status().waitFor();await saved();
 check(await page.getByRole('heading',{name:'必要量との比較（自動）',exact:true}).count()===1&&await page.getByRole('button',{name:'必要量との比較（自動）',exact:true}).count()===0,'comparison is a non-action heading with immediate statuses');
 check((await status().innerText()).includes('✅')&&(await page.getByLabel('SYN-B の発注量チェック',{exact:true}).innerText()).includes('✅'),'correction and unread warnings do not obscure valid numerical comparison');
 check((await page.getByLabel('SYN-B の発注時の注意',{exact:true}).innerText()).includes('読み取りの注意'),'entry-only unread reason remains a separate visible notice');
 check(await page.getByRole('tabpanel').filter({visible:true}).getByRole('checkbox').count()===0,'overview contains no manual quantity or repeat check');
 await ui.edit(page,'SYN-A');
 check(await card(0).isVisible()&&await card(1).isVisible()&&await card(2).isVisible(),'all three materials can be visible and expanded simultaneously');
 await page.getByLabel('SYN-A のロス率を入力',{exact:true}).fill('');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('51');await ui.view(page,'概要');check((await status().innerText()).includes('✅'),'invalid reserve input does not hide computable required50.7 vs explicitly chosen51');await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A のロス率を入力',{exact:true}).fill('18');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('51');
 check(await page.getByRole('button',{name:'概要に戻る',exact:true}).count()===0&&await page.getByRole('button',{name:'数量に戻る',exact:true}).count()===0,'redundant return buttons are removed');
 await card(0).getByRole('button',{name:'SYN-A の詳細を省略',exact:true}).click();
 check(await card(0).getByRole('button',{name:'SYN-A の詳細を展開',exact:true}).isVisible()&&await card(1).getByRole('button',{name:'SYN-B の詳細を省略',exact:true}).isVisible(),'collapsing A leaves B expanded');
 await page.getByLabel('編集する品番',{exact:true}).selectOption('SYN-A');
 check(await page.getByLabel('SYN-A の壁の高さ (m)',{exact:true}).isVisible()&&await card(1).isVisible(),'product selector jumps/opens its target while retaining other visible materials');
 await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('50');await ui.view(page,'概要');
 await wait(()=>status().innerText().then(t=>t.includes('0.7m不足')));
 const allAdd=()=>page.getByRole('button',{name:/すべて発注リストへ追加/});check(await allAdd().isEnabled(),'shortage warning permits adding the selected50m');
 const open=async()=>{await page.getByRole('button',{name:'確認してコピー',exact:true}).click();await page.getByRole('dialog').waitFor();},close=async()=>{await page.getByRole('dialog').getByRole('button',{name:'戻る',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});};
 await open();check((await page.getByLabel('SYN-A のコピー前の必要量比較',{exact:true}).innerText()).includes('0.7m不足'),'dialog retains the same exact advisory shortage without blocking output');await page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).click();
 check(await page.evaluate(()=>window.copied.at(-1).text.includes('数量：50m')&&window.copied.at(-1).text.includes('現場名：Source A')&&window.copied.at(-1).active),'explicit user tap copies chosen shortage amount and its own source site');
 await close();check(!(await read()).parsed.items[0].reading_review_confirmation,'copying never records a source acknowledgement');
 await ui.edit(page,'SYN-A');await card(0).getByTitle('タップして式を編集').first().click();await page.getByLabel('SYN-A 1行目の長さ (m)',{exact:true}).fill('');
 await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('23');await ui.view(page,'概要');
 check((await status().innerText()).includes('判定不可')&&await allAdd().isEnabled()&&(await page.getByLabel('SYN-A の一覧発注数量',{exact:true}).innerText())==='23m','unfinished source row retains/export23m; only comparison becomes unknown');
 await open();check(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).isEnabled(),'CopyReview does not reintroduce incomplete-measurement or reading gates');await close();
 for(const raw of['','-1']){await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill(raw);await ui.view(page,'概要');check(await allAdd().isDisabled()&&(await page.getByLabel('SYN-A の一覧発注数量',{exact:true}).innerText())==='未確定','invalid FINAL order '+JSON.stringify(raw)+' is preserved and never converted to zero/old total');}
 await ui.edit(page,'SYN-A');await page.getByLabel('SYN-A の発注数量を入力',{exact:true}).fill('23');if(!(await page.getByLabel('SYN-A 1行目の長さ (m)',{exact:true}).isVisible()))await card(0).getByTitle('タップして式を編集').first().click();await page.getByLabel('SYN-A 1行目の長さ (m)',{exact:true}).fill('50.7');await saved();
 await ui.view(page,'メモ画像');check(await page.getByLabel('表示中の結果の現場名',{exact:true}).count()===0&&(await page.getByLabel('前回の結果とリセット',{exact:true}).innerText()).includes('Source A'),'photo tab uses bound source site without a second edit field');
 await ui.view(page,'概要');await ui.disclosure(page,'画像・現場名');await page.getByRole('region',{name:'メモ計測',exact:true}).getByLabel('現場名（任意）',{exact:true}).fill('Next D');await saved();await open();await page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).click();check(await page.evaluate(()=>window.copied.at(-1).text.includes('Source A')&&!window.copied.at(-1).text.includes('Next D')),'changing next upload site does not relabel the old result');await close();
 await ui.mode(page,'発注リスト');const draftCopy=()=>page.getByRole('button',{name:/発注リストをコピー|コピーしました/,exact:true});
 await page.getByLabel('DRAFTの数量',{exact:true}).fill('');await saved();check(await draftCopy().isDisabled()&&(await read()).orderDraftItems[0].quantity===23&&(await read()).orderDraftItems[0].quantityInput==='','blank draft input retains old numeric backup but cannot export it');
 await page.reload();await page.getByLabel('SYN-A の一覧発注数量',{exact:true}).waitFor();await ui.mode(page,'発注リスト');check(await page.getByLabel('DRAFTの数量',{exact:true}).inputValue()===''&&await draftCopy().isDisabled(),'blank final draft survives reload and stays non-exportable');
 await page.getByLabel('DRAFTの数量',{exact:true}).fill('0');await saved();check(await draftCopy().isEnabled(),'existing explicit draft zero remains allowed without extending memo-zero policy');await draftCopy().click();check(await page.evaluate(()=>window.copied.at(-1).text.includes('数量：0m')),'explicit draft zero is copied as zero, never replaced with a total');await page.getByLabel('手動の品番',{exact:true}).fill('');check(await draftCopy().isDisabled(),'blank final product code cannot be silently serialized as unknown');await page.getByLabel('手動の品番',{exact:true}).fill('DRAFT');
 await ui.mode(page,'メモ計測');await ui.view(page,'概要');await ui.disclosure(page,'保存済みの結果を開く');await page.getByRole('button',{name:'保存済みの解析結果を探す',exact:true}).click();
 await page.getByRole('button',{name:'保存済み「Result B」の結果を確認',exact:true}).waitFor();
 check(await page.getByRole('button',{name:/保存済み「.*」の結果を確認/}).count()===2,'history filters only null/empty/whitespace source names; literal named 現場名なし is retained');
 await page.getByRole('button',{name:'保存済み「Result B」の結果を確認',exact:true}).click();await page.getByRole('heading',{name:'別の解析結果があります',exact:true}).waitFor();
 check((await read()).resultSiteName==='Source A'&&(await read()).parsed.items[0].product_code==='SYN-A','named-history selection enters existing conflict protection without overwriting current edits');
 if(process.env.SOKUPA_SCREENSHOT_DIR&&!mode){fs.mkdirSync(process.env.SOKUPA_SCREENSHOT_DIR,{recursive:true});await ui.edit(page,'SYN-A');await page.screenshot({path:`${process.env.SOKUPA_SCREENSHOT_DIR}/multiple-materials-${width}.png`});}
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'workspace fits narrow mobile width');
 check(!errors.length&&!unexpected.length&&calls.every(call=>call.startsWith('GET ')||call.endsWith('/seen')),'no browser errors, real AI/LINE calls or user-data API mutations');
 await context.close();
}
console.log(JSON.stringify({checks,widths:[320,390],normalBasic:true,physicalIPhone:false,realAI:0,realLINE:0,productionMutations:0}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
