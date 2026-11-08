// Actual component, isolated contexts and stubbed requests. No provider or LINE.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const bundle=fs.readFileSync(process.env.SOKUPA_IDENTITY_BUNDLE,'utf8');let checks=0;
const check=(v,label)=>{assert.ok(v,label);console.log(`PASS ${++checks}: ${label}`);};
const wait=async fn=>{for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Identity condition timed out');};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
for(const basic of[false,true])for(const width of[320,390]){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true}),page=await context.newPage(),errors=[],unexpected=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin==='http://127.0.0.1:18996'&&u.pathname==='/harness')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});unexpected.push(u.href);return route.abort();});
 await page.addInitScript(({basic})=>{window.basic=basic;window.seed=[51,23].map((n,i)=>({product_code:'DUP',manufacturer:'Synthetic',entries:[{source_row_id:'source-'+i,source_image_index:i,source_entry_index:0,original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7}],total_m:50.7,order_quantity:n,manual_order_quantity:n,loss_rate_percent:18,repeat_cm:60,measurement_basis:'trim-included',pattern_match:'straight'}));},{basic});
 await page.goto('http://127.0.0.1:18996/harness');await page.addScriptTag({content:bundle});
 const read=()=>page.evaluate(()=>structuredClone(window.items)),set=items=>page.evaluate(items=>window.setMaterials(items),items),card=id=>page.locator(`[data-material-id="${id}"]`);
 await page.getByRole('tab',{name:'数量',exact:true}).click();await wait(()=>read().then(a=>a.every(i=>i.client_material_id)));
 let state=await read(),a=state[0].client_material_id,b=state[1].client_material_id;
 await card(a).getByLabel('DUP の発注数量を入力',{exact:true}).fill('61');await wait(()=>read().then(a=>a[0].order_quantity===61));
 await page.evaluate(()=>window.reorderMaterials());await wait(()=>read().then(x=>x[0].client_material_id===b));
 state=await read();check(state[0].order_quantity===23&&state[1].order_quantity===61,'reorder keeps source-1=23 and edited source-0=61');
 check(await card(a).getByLabel('DUP の発注数量を入力',{exact:true}).inputValue()==='61','numeric editor follows immutable material after reorder');
 await card(a).getByLabel('DUP に追加する長さ (m)',{exact:true}).fill('1.25');await card(a).getByLabel('DUP に追加する幅数',{exact:true}).fill('3');
 await card(a).getByTitle('タップして品番を編集',{exact:true}).click();await card(a).getByLabel('品番を編集',{exact:true}).fill('PENDING');
 await page.evaluate(()=>window.reorderMaterials());await wait(()=>read().then(x=>x[0].client_material_id===a));
 check(await card(a).getByLabel('品番を編集',{exact:true}).inputValue()==='PENDING'&&await card(a).getByLabel('DUP に追加する長さ (m)',{exact:true}).inputValue()==='1.25','uncommitted code and unadded row follow material on reorder');
 check((await page.evaluate(()=>window.calls.filter(c=>c.url==='/api/memo-corrections'))).length===0,'reorder never commits code or posts correction');
 await card(a).getByLabel('品番を編集',{exact:true}).press('Enter');await wait(()=>read().then(x=>x.find(i=>i.client_material_id===a).product_code==='PENDING'));
 check((await read()).find(i=>i.client_material_id===b).product_code==='DUP'&&(await read()).find(i=>i.client_material_id===a).order_quantity===61,'explicit Enter rename keeps manual61 and other duplicate23');
 const fresh=structuredClone((await read())[0]);delete fresh.client_material_id;fresh.product_code='NEW';fresh.manual_order_quantity=7;fresh.order_quantity=7;fresh.entries[0].source_row_id='new-source';fresh.entries[0].source_image_index=2;
 await set([fresh,...await read()]);await wait(()=>read().then(x=>x.length===3&&x[0].client_material_id));
 state=await read();check(state.find(i=>i.client_material_id===a).order_quantity===61&&state.find(i=>i.client_material_id===b).order_quantity===23,'prepend does not transfer quantity to new first item');
 await set(state.slice(1));await wait(()=>read().then(x=>x.length===2));
 check((await read()).find(i=>i.client_material_id===a).order_quantity===61,'delete first material preserves remaining identity');
 check(await card(a).getByLabel('PENDING に追加する長さ (m)',{exact:true}).inputValue()==='1.25','new-row draft survives insertion/deletion and SKU rename');
 await card(a).getByRole('button',{name:'解析結果に戻す',exact:false}).click();await wait(()=>read().then(x=>x.find(i=>i.client_material_id===a).product_code==='DUP'));
 check((await read()).find(i=>i.client_material_id===b).order_quantity===23&&(await read()).find(i=>i.client_material_id===a).entries[0].source_row_id==='source-0','original reset uses correct source after reorder');
 await card(a).getByLabel('DUP の発注数量を入力',{exact:true}).fill('61');await wait(()=>read().then(x=>x.find(i=>i.client_material_id===a).order_quantity===61));
 await page.evaluate(()=>window.restoreMaterials(window.seed));await wait(()=>read().then(x=>x[0].order_quantity===51));
 check((await read())[1].order_quantity===23,'old same-job snapshot restores51 and preserves23 instead of overlay61');
 const legacy=(await read()).map(({client_material_id,...item})=>item).reverse();await set(legacy);await wait(()=>read().then(x=>x[0].entries[0].source_row_id==='source-1'));
 check((await read())[0].client_material_id===b&&(await read())[0].order_quantity===23,'legacy reorder matches unique immutable source anchor');
 // Truly identical data without source references is not enough to identify two materials.
 const anonymous=structuredClone((await read())[0]);delete anonymous.client_material_id;anonymous.entries=anonymous.entries.map(({source_row_id,source_image_index,source_entry_index,...e})=>e);anonymous.order_quantity=23;anonymous.manual_order_quantity=23;
 await set([anonymous,structuredClone(anonymous)]);await wait(()=>read().then(x=>x.length===2&&x.every(i=>i.client_material_id)&&!x[0].entries[0].source_row_id));
 let old=await read(),c=old[0].client_material_id,d=old[1].client_material_id;
 await card(c).getByLabel('DUP の発注数量を入力',{exact:true}).fill('61');await wait(()=>read().then(x=>x[0].order_quantity===61));
 await page.evaluate(()=>window.reorderMaterials());await wait(()=>read().then(x=>x[0].client_material_id===d));
 check((await read())[0].order_quantity===23&&(await read())[1].order_quantity===61,'identical same-SKU materials with persisted IDs stay independent');
 await set([anonymous,structuredClone(anonymous)]);await wait(()=>read().then(x=>x.every(i=>i.client_material_id!==c&&i.client_material_id!==d)));
 check((await read()).every(i=>i.order_quantity===23),'ambiguous ID-less legacy replacement never borrows61');
 await page.getByText('切り替え前の入力を保全しました',{exact:true}).click();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'保全した入力を書き出す',exact:true}).click();const saved=await download,path=await saved.path();const recovered=JSON.parse(fs.readFileSync(path,'utf8'));
 check(recovered.materials.some(i=>i.client_material_id===c&&i.order_quantity===61),'detached old input61 remains downloadable, never silently discarded');
 const current=(await read())[0].client_material_id;await card(current).getByLabel('DUP の発注数量を入力',{exact:true}).fill('73');await wait(()=>read().then(x=>x[0].order_quantity===73));
 await page.evaluate(()=>{window.setResultJob('00000000-0000-4000-8000-00000000000b');window.setMaterials(window.seed);});await wait(()=>read().then(x=>x[0].entries[0].source_row_id==='source-0'&&x[0].order_quantity===51));
 check((await read())[1].order_quantity===23,'different-job selection never inherits manual73');
 check(errors.length===0&&unexpected.length===0,'identity transitions have no console/runtime error or real network');
 await context.close();
}
console.log(JSON.stringify({checks,synthetic:true,normalBasic:true,widths:[320,390],realAI:0,realLINE:0}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
