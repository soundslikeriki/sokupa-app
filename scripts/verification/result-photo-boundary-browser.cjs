const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const ui=require('./result-workspace-helpers.cjs');
const bases=[process.env.SOKUPA_TEST_URL,process.env.SOKUPA_BASIC_URL],job='00000000-0000-4000-8000-00000000000a';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
let checks=0;const check=(v,m)=>{assert.ok(v,m);console.log(`PASS ${++checks}: ${m}`);};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 for(const base of bases){assert.equal(new URL(base).hostname,'127.0.0.1');
 for(const failure of [401,403,404]){
  const context=await browser.newContext({viewport:{width:320,height:844}}),owner='synthetic-photo',key=`sokupa:workspace:v1:${owner}`;let status=failure,requests=[];
 await ui.freshResultFixtures(context);
  await context.addInitScript(({key,job})=>{localStorage.setItem(key,JSON.stringify({version:1,siteName:'Synthetic',parsed:{items:[{product_code:'PHOTO',manufacturer:'Synthetic',entries:[{original_formula:'2×1',length_m:2,quantity:1,subtotal_m:2,source_image_index:0}],total_m:2,order_quantity:3,reading_reviews:[{reason:'Synthetic source index mismatch',candidate_formulas:['2×1'],source_image_index:1}]}]},orderDraftItems:[],resultJobId:job}));},{key,job});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:owner}});
   if(u.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:[]}});
   if(u.pathname.endsWith('/seen'))return route.fulfill({json:{success:true}});
   if(u.pathname===`/api/analysis-jobs/${job}`)return route.fulfill({json:{data:{id:job,total_images:1}}});
   if(u.pathname.startsWith(`/api/analysis-jobs/${job}/images/`)){requests.push(u.pathname);return route.fulfill(status===200?{contentType:'image/png',body:png}:{status,json:{error:'Synthetic photo refusal'}});}
   if(u.pathname.startsWith('/api/'))throw Error('Unexpected API '+u.pathname);return route.continue();
  });
  const page=await context.newPage();await page.goto(base);await ui.edit(page,'PHOTO');await page.getByLabel('PHOTO の個別照合詳細',{exact:true}).locator(':scope > summary').click();await page.getByRole('button',{name:'PHOTO の訂正候補の写真 2を確認',exact:true}).click();
  await page.getByText('指定されたメモ画像が見つかりません。',{exact:false}).waitFor();check(requests.length===0,'invalid source index does not silently substitute another image');
  await page.getByRole('button',{name:'写真 1',exact:true}).click();await page.getByRole('button',{name:'写真を再取得',exact:true}).waitFor();check(requests.length===1,`${failure} yields an explicit current-photo error`);
  status=200;await page.getByRole('button',{name:'写真を再取得',exact:true}).click();await page.getByAltText('解析元の写真 1',{exact:true}).waitFor();check(await page.getByAltText('解析元の写真 1',{exact:true}).getAttribute('src')===`/api/analysis-jobs/${job}/images/0`,'safe retry keeps the displayed owner job');
  await ui.view(page,'数量');check(await page.getByLabel('編集する品番').inputValue()==='PHOTO','photo failure and retry preserve selected editor');await context.close();
 }
 }
 console.log(JSON.stringify({checks,realAiCalls:0,realLineSends:0,synthetic:true}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
