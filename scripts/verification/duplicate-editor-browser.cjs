// Actual OrderList with distinct same-SKU materials. No real API or clipboard access.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const bundle=fs.readFileSync(process.env.SOKUPA_COPY_REVIEW_BUNDLE,'utf8');let checks=0;
const check=(value,label)=>{assert.ok(value,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<250;n++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Duplicate editor condition timed out');};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
for(const basic of[false,true])for(const width of[320,390]){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true}),page=await context.newPage(),errors=[],unexpected=[];
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin==='http://127.0.0.1:18900'&&u.pathname==='/harness')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});unexpected.push(u.href);return route.abort();});
 await page.addInitScript(({basic})=>{window.basic=basic;window.noJob=true;window.seed=[51,23].map((quantity,index)=>({product_code:'DUP',manufacturer:'Synthetic',entries:[{source_row_id:'source-'+index,source_image_index:index,source_entry_index:0,original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7}],total_m:50.7,order_quantity:quantity,manual_order_quantity:quantity,loss_rate_percent:18,repeat_cm:60,measurement_basis:'trim-included',pattern_match:'straight'}));window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.copied.push(text);return Promise.resolve();}}});},{basic});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());await page.goto('http://127.0.0.1:18900/harness');await page.addScriptTag({content:bundle});
 const read=()=>page.evaluate(()=>window.items),card=index=>page.locator(`[data-material-index="${index}"]`);
 await page.getByRole('tab',{name:'数量',exact:true}).click();await wait(()=>read().then(items=>items[0].order_quantity===51&&items[1].order_quantity===23));
 await card(1).getByRole('button',{name:'DUP の発注数量を1m増やす',exact:true}).click();await wait(()=>read().then(items=>items[1].order_quantity===24));check((await read())[0].order_quantity===51,'second duplicate plus changes23→24 while first stays51');
 await card(0).getByRole('button',{name:'DUP の発注数量を1m増やす',exact:true}).click();await wait(()=>read().then(items=>items[0].order_quantity===52));check((await read())[1].order_quantity===24,'first duplicate plus never changes second24');
 await card(1).getByLabel('DUP の壁の高さ (m)',{exact:true}).fill('2.7');await wait(()=>read().then(items=>items[1].repeat_height_m===2.7));check((await read())[0].repeat_height_m===undefined&&(await read())[0].order_quantity===52,'common height applies to its material only');
 await card(1).getByLabel('DUP 1行目のリピート計算',{exact:true}).click();await wait(()=>read().then(items=>items[1].entries[0].repeat_enabled===true));check(!(await read())[0].entries[0].repeat_enabled&&(await read())[0].order_quantity===52,'row repeat does not enable another same-SKU material');
 await card(1).getByLabel('DUP のロス率を入力',{exact:true}).fill('20');await wait(()=>read().then(items=>items[1].loss_rate_percent===20));check((await read())[0].loss_rate_percent===18,'reserve remains material-local');
 await card(1).getByTitle('タップして式を編集',{exact:true}).click();await card(1).getByLabel('DUP 1行目の長さ (m)',{exact:true}).fill('');await wait(()=>read().then(items=>items[1].entries[0].length_input===''));check((await read())[0].entries[0].length_input===undefined&&(await read())[0].entries[0].length_m===50.7,'blank row input never blanks another material');
 await card(1).getByLabel('DUP の発注数量を入力',{exact:true}).fill('23');await wait(()=>read().then(items=>items[1].order_quantity===23));
 await card(1).getByLabel('DUP に追加する長さ (m)',{exact:true}).fill('1.25');await card(1).getByLabel('DUP に追加する幅数',{exact:true}).fill('3');
 await card(1).getByTitle('タップして品番を編集',{exact:true}).click();await card(1).getByLabel('品番を編集',{exact:true}).fill('DUP-EDIT');await card(1).getByLabel('品番を編集',{exact:true}).press('Enter');
 await wait(()=>read().then(items=>items[1].product_code==='DUPEDIT'));check((await read())[0].product_code==='DUP'&&(await read())[0].order_quantity===52,'renaming one duplicate leaves the other code and amount intact');
 check(await card(1).getByLabel('DUPEDIT に追加する長さ (m)',{exact:true}).inputValue()==='1.25'&&(await read())[1].entries[0].length_input===''&&(await read())[1].order_quantity===23,'rekeying preserves raw row, manual23 and unadded-row draft');
 const posts=await page.evaluate(()=>window.calls.filter(call=>call.url==='/api/memo-corrections'));check(posts.length===1&&JSON.parse(posts[0].body).before.product_code==='DUP'&&JSON.parse(posts[0].body).after.product_code==='DUPEDIT','one correction uses a real product code, never an internal editor key');
 await card(1).getByRole('button',{name:'幅数を追加',exact:true}).click();await wait(()=>read().then(items=>items[1].entries.length===2));check((await read())[0].entries.length===1&&(await read())[0].order_quantity===52,'adding a row affects only its material');
 await card(1).getByRole('button',{name:'この数式を削除',exact:true}).nth(1).click();await wait(()=>read().then(items=>items[1].entries.length===1));check((await read())[0].entries[0].source_row_id==='source-0','row deletion preserves the other source row');
 await card(1).getByRole('button',{name:'解析結果に戻す',exact:false}).click();await wait(()=>read().then(items=>items[1].product_code==='DUP'));check((await read())[0].order_quantity===52,'reset to original safely reintroduces the duplicate without changing the first amount');
 check((await read()).every(item=>!Object.prototype.hasOwnProperty.call(item,'editorKey')),'private editor keys never enter saved canonical results');
 check(errors.length===0&&unexpected.length===0,'duplicate editing has no runtime error or real request');await context.close();
}
console.log(JSON.stringify({checks,synthetic:true,normalBasic:true,widths:[320,390],realAI:0,realLINE:0,productionMutations:0}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
