// Old unfinished work must never be replayed automatically or lock a fresh analysis.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317',user='synthetic-legacy-owner',old='00000000-0000-4000-8000-000000000001',fresh='00000000-0000-4000-8000-000000000002';
const pointer=`sokupa:lastJobId:${user}`;
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 try{for(const rolling of [false,true]){
  let resumeOld=0,created=false,done=false;const context=await browser.newContext({viewport:{width:375,height:900}}),page=await context.newPage();
  await context.addInitScript(({pointer,old})=>localStorage.setItem(pointer,old),{pointer,old});
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:user}});
   if(u.pathname==='/api/analysis-jobs'&&route.request().method()==='GET')return route.fulfill({json:{data:[]}});
   if(u.pathname===`/api/analysis-jobs/${old}`)return route.fulfill({json:{data:{id:old,status:'running',execution_mode:'legacy',can_resume:rolling,requires_manual_restart:rolling?undefined:true,total_images:1,done_images:0,result:null}}});
   if(u.pathname===`/api/analysis-jobs/${old}/resume`){resumeOld++;return route.fulfill({status:409,json:{error:'Legacy restart required'}});}
   if(u.pathname==='/api/memo-images')return route.fulfill({json:{object_path:user+'/synthetic.jpg'}});
   if(u.pathname==='/api/analysis-jobs'){created=true;return route.fulfill({json:{job_id:fresh,execution_mode:'scheduled-wake',background_ready:true}});}
   if(u.pathname===`/api/analysis-jobs/${fresh}`)return route.fulfill({json:{data:{id:fresh,status:done?'done':'running',execution_mode:'scheduled-wake',can_resume:false,background_ready:true,total_images:1,done_images:done?1:0,site_name:'',notification_status:'accepted',result:done?{items:[{product_code:'FRESH',manufacturer:'Synthetic',entries:[{original_formula:'20×1',length_m:20,quantity:1,subtotal_m:20}],total_m:20,order_quantity:23}]}:null}}});
   if(u.pathname===`/api/analysis-jobs/${fresh}/seen`)return route.fulfill({json:{success:true}});
   if(u.pathname.startsWith('/api/'))throw Error('Unexpected API '+u.pathname);return route.continue();
  });
  await page.goto(base);await page.getByText('以前の未完了解析は保存されています。',{exact:false}).waitFor();assert.equal(resumeOld,0);checks++;
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=32;return c.toDataURL('image/png').split(',')[1];});
  await page.locator('input[type=file]').setInputFiles({name:'new.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByAltText('プレビュー 1',{exact:true}).waitFor();
  const button=page.getByRole('button',{name:'1枚の画像を解析する',exact:true});assert.equal(await button.isEnabled(),true);checks++;
  await button.click();await page.getByText('解析を受け付けました',{exact:true}).waitFor();assert.ok(created);assert.equal(await page.evaluate(k=>localStorage.getItem(k),pointer),fresh);assert.equal(resumeOld,0);checks++;
  done=true;await page.getByLabel('FRESH の発注数量を入力',{exact:true}).waitFor();assert.equal(await page.getByLabel('FRESH の発注数量を入力',{exact:true}).inputValue(),'23');assert.equal(resumeOld,0);checks++;
  await context.close();
 }
 console.log(`PASS: ${checks} legacy-job browser checks; no old replay, rolling metadata, fresh intake and completion; no external requests.`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
