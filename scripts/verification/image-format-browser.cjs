const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const base=process.env.SOKUPA_TEST_URL||'http://127.0.0.1:3317';
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let checks=0;
 try{for(const extension of ['png','jpg','heic','broken']){
  let uploads=0;const context=await browser.newContext({viewport:{width:375,height:900}}),page=await context.newPage();
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{authenticated:true,line_user_id:'synthetic-format-user'}});
   if(u.pathname==='/api/analysis-jobs')return route.fulfill({json:{data:[]}});
   if(u.pathname==='/api/memo-images'){uploads++;return route.abort();}
   if(u.pathname.startsWith('/api/'))throw Error('Unexpected API '+u.pathname);return route.continue();
  });
  await page.goto(base);await page.getByRole('tab',{name:'概要',exact:true}).waitFor();
  if(extension==='broken')await page.locator('input[type=file]').setInputFiles({name:'broken.heic',mimeType:'image/heic',buffer:Buffer.from('not a valid HEIC image')});
  else await page.locator('input[type=file]').setInputFiles(`/tmp/sokupa-synthetic-format.${extension}`);
  const button=page.getByRole('button',{name:'1枚の画像を解析する',exact:true});
  if(extension==='broken'){
   await page.getByText('画像の読み込み・変換に失敗しました',{exact:false}).waitFor({timeout:30000});assert.equal(await button.isDisabled(),true);checks++;
   assert.equal(await page.getByAltText('プレビュー 1',{exact:true}).count(),0);checks++;
  }else{
   const preview=page.getByAltText('プレビュー 1',{exact:true});await preview.waitFor({timeout:30000});
   assert.ok(await preview.evaluate(image=>image.naturalWidth>0&&image.naturalHeight>0));checks++;
   assert.equal(await button.isEnabled(),true);checks++;
  }
  assert.equal(uploads,0);await context.close();
 }
 console.log(`PASS: ${checks} image-format browser checks; PNG/JPEG/Apple HEIC decode and corrupt-file refusal; no uploads, AI or LINE.`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
