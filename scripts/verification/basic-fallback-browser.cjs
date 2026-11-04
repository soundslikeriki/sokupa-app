// Switch two real local builds under one browser origin, as an alias rollback would.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const full=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3318',basic=process.env.SOKUPA_BASIC_URL||'http://127.0.0.1:3319';
for(const origin of [full,basic])assert.equal(new URL(origin).hostname,'127.0.0.1');
const owner='synthetic-basic-fallback',key=`sokupa:workspace:v1:${owner}`,a='00000000-0000-4000-8000-00000000000a',b='00000000-0000-4000-8000-00000000000b';
const original={items:[{product_code:'HEIGHT',manufacturer:'Synthetic',measurement_basis:'trim-included',pattern_match:'straight',repeat_cm:60,manual_order_quantity:15,entries:[{source_row_id:'image-0:row-0',source_image_index:0,source_entry_index:0,original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4,repeat_enabled:true},{source_row_id:'image-1:row-0',source_image_index:1,source_entry_index:0,original_formula:'3.8×1',length_m:3.8,quantity:1,subtotal_m:3.8,repeat_enabled:true}],total_m:10.2,order_quantity:15}]};
const edited=structuredClone(original);edited.items[0].entries[1].length_input='';
const fresh={items:[{product_code:'FRESH',manufacturer:'Synthetic',entries:[{original_formula:'2.5×2',length_m:2.5,quantity:2,subtotal_m:5}],total_m:5,order_quantity:6}]};
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};const wait=async f=>{for(let i=0;i<300;i++){if(await f())return;await new Promise(r=>setTimeout(r,70));}throw Error('Fallback condition timed out');};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const context=await browser.newContext({viewport:{width:390,height:844}});let backend=full,done=false,created=false;
 await context.addInitScript(({key,edited,original,a})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,siteName:'Edited full view',parsed:edited,originalParsed:original,orderDraftItems:[],resultJobId:a}));},{key,edited,original,a});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==full)return route.abort();
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner,admin:true}});
  if(u.pathname==='/api/memo-images')return route.fulfill({json:{object_path:`${owner}/${b}.jpg`}});
  if(u.pathname==='/api/analysis-jobs'){if(route.request().method()==='POST'){created=true;return route.fulfill({json:{success:true,job_id:b,background_ready:true,execution_mode:'scheduled-wake'}});}return route.fulfill({json:{data:[]}});}
  if(u.pathname.endsWith('/seen')||u.pathname.endsWith('/resume'))return route.fulfill({json:{success:true}});
  if(u.pathname===`/api/analysis-jobs/${b}`)return route.fulfill({json:{data:{id:b,status:done?'done':'running',site_name:'Edited basic view',result:done?fresh:null,notification_status:'accepted',total_images:1,done_images:done?1:0,background_ready:true,execution_mode:'scheduled-wake'}}});
  if(u.pathname.startsWith('/api/'))throw Error('Unexpected API '+u.pathname);
  return route.fulfill({response:await route.fetch({url:backend+u.pathname+u.search,maxRedirects:0})});
 });
 let page=await context.newPage();page.on('pageerror',e=>{throw e;});const read=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);const saved=()=>wait(()=>page.getByLabel('結果の保存状態').innerText().then(s=>s.includes('保存済み')));
 await page.goto(full);await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).waitFor();await saved();check((await read()).parsed.items[0].entries[1].length_input==='','normal build retains incomplete measurement');
 backend=basic;await page.reload();await page.getByText('基本表示中です。',{exact:false}).waitFor();await saved();
 check(await page.getByLabel('HEIGHT の寸法区分',{exact:true}).count()===0,'optional comparison UI omitted');check(await page.getByRole('button',{name:'HEIGHT 明細2の写真を確認',exact:true}).count()===0,'optional photo UI omitted');
 check((await read()).parsed.items[0].entries[1].length_input==='','fallback never drops new raw input fields');check((await read()).originalParsed.items[0].entries.length===2,'fallback retains original result');check((await read()).parsed.items[0].order_quantity===15,'switch alone preserves the manual quantity');
 check(await page.getByRole('button',{name:'発注用テキストをコピー',exact:true}).isDisabled(),'fallback refuses incomplete output');
 await page.getByTitle('タップして式を編集').nth(1).click();await page.getByLabel('HEIGHT 2行目の長さ (m)',{exact:true}).fill('3.8');await wait(()=>read().then(d=>d.parsed.items[0].entries[1].length_input===undefined));await saved();
 const item=(await read()).parsed.items[0];check(item.entries[0].length_m===2.7&&item.entries[1].length_m===3.8,'fallback preserves both original heights');check(item.total_m===10.2&&item.order_quantity===12,'fallback recalculates repeated lengths exactly');await page.getByLabel('HEIGHT の発注数量を入力',{exact:true}).fill('15');await wait(()=>read().then(d=>d.parsed.items[0].order_quantity===15));
 await page.getByLabel('HEIGHT のメモと発注数量を確認済みにする',{exact:true}).check();await saved();
 await page.getByRole('button',{name:'発注リストに追加',exact:true}).click();await wait(()=>read().then(d=>d.orderDraftItems.length===1));check((await read()).orderDraftItems[0].quantity===15,'fallback transfers correct order quantity');
 await page.getByLabel('現場名（任意）',{exact:true}).filter({visible:true}).first().fill('Edited basic view');await wait(()=>read().then(d=>d.siteName==='Edited basic view'));await saved();
 backend=full;await page.reload();await page.getByLabel('HEIGHT の寸法区分',{exact:true}).waitFor();await saved();check((await read()).siteName==='Edited basic view'&&(await read()).orderDraftItems.length===1,'switching back preserves edits and order draft');
 await page.getByLabel('HEIGHT の必要量の前提を確認済みにする',{exact:true}).check();await wait(()=>read().then(d=>Boolean(d.parsed.items[0].quantity_confirmation)));await saved();
 const confirmation=(await read()).parsed.items[0].quantity_confirmation;const fullBadge=page.getByText('発注内容確認済',{exact:true}).locator('..');check((await fullBadge.getAttribute('class')).includes('emerald'),'normal view still shows verified badge');
 backend=basic;await page.reload();await page.getByText('基本表示中です。',{exact:false}).waitFor();await saved();const basicBadge=page.getByText('数量を確認',{exact:true}).locator('..');
 check(!(await basicBadge.getAttribute('class')).includes('emerald'),'basic never keeps a green confirmed badge');check(!(await basicBadge.locator('svg').getAttribute('class')).includes('check'),'basic has a review icon after confirmed normal view');check((await read()).parsed.items[0].quantity_confirmation===confirmation,'view switch preserves confirmation data without claiming certainty');
 const statuses=page.getByRole('status').filter({hasText:'確認済み：入力した発注数量'});check(await statuses.count()===2,'basic shows the confirmed check and acknowledgement messages');
 for(const status of await statuses.all()){const text=await status.innerText(),classes=await status.getAttribute('class');check(!text.includes('✅')&&!classes.includes('emerald')&&classes.includes('text-muted-foreground'),'basic confirmed messages use neutral color without a success checkmark');}
 await page.getByRole('radio',{name:'メモの数量を使う（予備分を確認）',exact:true}).check();await page.getByLabel('HEIGHT のメモと発注数量を確認済みにする',{exact:true}).check();await saved();
 for(const status of await page.getByRole('status').filter({hasText:'確認済み：入力した発注数量'}).all())check((await status.getAttribute('class')).includes('text-muted-foreground'),'basic memo confirmation remains neutral');
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;return c.toDataURL('image/png').split(',')[1];});await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();await page.getByRole('button',{name:'1枚の画像を解析する',exact:true}).click();await wait(()=>created);await page.getByText('解析を受け付けました',{exact:true}).waitFor();check((await read()).resultJobId===a,'basic keeps previous result while job pending');await page.close();done=true;
 backend=full;page=await context.newPage();await page.goto(full);await page.getByLabel('FRESH の発注数量を入力',{exact:true}).waitFor();await saved();check((await read()).resultJobId===b&&(await read()).parsed.items[0].order_quantity===6,'accepted job survives closing basic and reopening normal');
 console.log(JSON.stringify({checks,sameBrowserOrigin:true,fullBasicFull:true,rawDraftPreserved:true,acceptedJobPreserved:true,realAiCalls:0,realLineSends:0}));await context.close();
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
