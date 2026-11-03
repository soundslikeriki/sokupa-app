// Actual API handlers, SDK, RLS, Storage and job processor. Synthetic LINE/OCR only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const{Client}=require(process.env.PG_CLIENT_MODULE||'pg');const{createClient}=require('@supabase/supabase-js');const{NextRequest}=require('next/server');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Explicit disposable native stack required');
const state=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.API_URL);
if(state?.runtime!=='native')throw Error('Local REST and Storage stack required');
for(const target of [state.env.DB_URL,state.env.API_URL])if(!['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname))throw Error('Non-local service refused');
const db=new Client({connectionString:state.env.DB_URL,ssl:false,connectionTimeoutMillis:5000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),savedFetch=global.fetch;
const names=['SESSION_SECRET','ADMIN_LINE_USER_ID','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','ANALYSIS_BACKGROUND_MODE','GEMINI_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','LINE_CHANNEL_ACCESS_TOKEN'];const saved=names.map(n=>process.env[n]);
let checks=0,vision=0,notices=0,previousMode='scheduled';const pending=new Set();
const contextSymbol=Symbol.for('@vercel/request-context'),savedContext=globalThis[contextSymbol];
const check=(v,message)=>{assert.ok(v,message);checks++;console.log(JSON.stringify({check:checks,message}));};
const row=async(s,a)=>(await db.query(s,a)).rows[0];
const idle=async()=>{while(pending.size)await Promise.allSettled([...pending]);};
(async()=>{
 await db.connect();const directory=(await row("select current_setting('data_directory') data")).data;
 assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(root)+path.sep));
 assert.equal((await row('select id from sokupa_local_verification_only')).id,'synthetic-only');
 if(!(await row("select to_regclass('public.analysis_execution_policy') present")).present)await db.query(fs.readFileSync('supabase/migrations/20261103070253_interactive_execution_policy.sql','utf8'));
 previousMode=(await row('select mode from analysis_execution_policy')).mode;
 await db.query("select set_analysis_execution_mode('interactive');notify pgrst,'reload schema'");
 check((await row("select count(*)::int n from cron.job where jobname like 'sokupa-local-%'")).n===0,'no scheduler runs in interactive verification');
 const tickCount=(await row('select count(*)::int n from analysis_worker_ticks')).n;
 const oldIds=(await db.query('select line_user_id from users order by line_user_id')).rows;
 process.env.SESSION_SECRET=fs.readFileSync(path.join(root,'dispatch-key'),'utf8'); // Reuse only this existing local test key.
 process.env.ADMIN_LINE_USER_ID='local-owner';process.env.NEXT_PUBLIC_SUPABASE_URL=state.env.API_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=state.env.SERVICE_ROLE_KEY;
 process.env.ANALYSIS_BACKGROUND_MODE='interactive';process.env.GEMINI_API_KEY='synthetic-only';process.env.GOOGLE_GENERATIVE_AI_API_KEY='synthetic-only';process.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic-only';
 global.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname==='api.line.me'){assert.equal(url.pathname,'/v2/bot/message/push');notices++;return new Response('{}',{headers:{'Content-Type':'application/json'}});}
  if(url.hostname==='generativelanguage.googleapis.com'){vision++;await sleep(31000);return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:JSON.stringify({items:[{product_code:'壁',entries:[{original_formula:'20×1',length_m:20,quantity:1}]}]})}]},finishReason:'STOP'}]}),{headers:{'Content-Type':'application/json'}});}
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'unexpected external traffic blocked');return savedFetch(input,{...init,redirect:'error'});
 };
 // The local harness records waitUntil promises; this does not emulate the Vercel timeout/runtime.
 globalThis[contextSymbol]={get:()=>({waitUntil:p=>{pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));}})};
 const{signToken,SESSION_COOKIE}=require('../../src/lib/session-token.ts');
 const{POST:create}=require('../../src/app/api/analysis-jobs/route.ts');
 const{POST:upload}=require('../../src/app/api/memo-images/route.ts');
 const{POST:resume}=require('../../src/app/api/analysis-jobs/[id]/resume/route.ts');
 const{GET:getJob}=require('../../src/app/api/analysis-jobs/[id]/route.ts');
 const{GET:session}=require('../../src/app/api/auth/session/route.ts');
 const base='https://sokupa.example.test';
 const req=(route,method='GET',body,user='local-owner')=>new NextRequest(base+route,{method,headers:{origin:base,cookie:`${SESSION_COOKIE}=${signToken('session',user,3600)}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const admin=createClient(state.env.API_URL,state.env.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 for(let i=0;i<30;i++){const r=await admin.rpc('analysis_admission_ready',{p_mode:'interactive'});if(!r.error&&r.data===true)break;if(i===29)throw Error('Local policy RPC not ready');await sleep(300);}
 const ownerSession=await(await session(req('/api/auth/session'))).json();
 check(ownerSession.authenticated&&ownerSession.admin&&ownerSession.line_user_id==='local-owner','actual session API preserves the existing owner and admin status');
 check(ownerSession.keep_open_for_progress===true,'session reports the interactive progress requirement');
 check((await row("select invite_code from users where line_user_id='local-owner'")).invite_code===null,'owner with missing invite history remains unchanged');
 const noAuth=await create(new NextRequest(base+'/api/analysis-jobs',{method:'POST',headers:{origin:base,'Content-Type':'application/json'},body:JSON.stringify({image_paths:['local-owner/0.jpg']})}));check(noAuth.status===401,'unsigned callers cannot enqueue work');
 const ownImage=async()=>{const id=crypto.randomUUID(),r=await upload(new NextRequest(base+'/api/memo-images',{method:'POST',headers:{origin:base,cookie:`${SESSION_COOKIE}=${signToken('session','local-owner',3600)}`,'Content-Type':'image/jpeg','x-upload-id':id},body:Buffer.from([255,216,255,224])}));check(r.status===200,'authenticated image API uploads into private Storage');return(await r.json()).object_path;};
 const submit=async(paths)=>{const r=await create(req('/api/analysis-jobs','POST',{image_paths:paths,site_name:'Synthetic'}));check(r.status===200,'actual job API admits interactive work without a scheduler');return(await r.json()).job_id;};
 const get=async(id,user='local-owner')=>getJob(req('/api/analysis-jobs/'+id,'GET',undefined,user),{params:{id}});
 const firstPath=await ownImage(),first=await submit([firstPath]);await idle();
 check((await(await get(first)).json()).data.status==='done','one 31-second image completes after the caller stops polling');
 check(notices===1,'one completed job records one mocked LINE acceptance');
 const second=await submit([await ownImage(),await ownImage()]);await idle();
 let current=(await(await get(second)).json()).data;
 check(current.status==='running'&&current.done_images===1&&current.can_resume,'closed-screen two-image job explicitly remains resumable after the first image');
 check(pending.size===0&&notices===1,'no hidden scheduler or completion notification advances the paused job');
 check((await get(second,'local-limited')).status===404,'another signed user cannot read this job');
 check((await resume(req('/api/analysis-jobs/'+second+'/resume','POST',{},'local-limited'),{params:{id:second}})).status===404,'another signed user cannot resume this job');
 const resumed=await Promise.all(Array.from({length:3},()=>resume(req('/api/analysis-jobs/'+second+'/resume','POST',{}),{params:{id:second}})));
 check(resumed.every(r=>r.status===202),'owner can reopen and resume the accepted job');await idle();
 current=(await(await get(second)).json()).data;
 check(current.status==='done'&&current.done_images===2,'actual processor finalizes both images after reopening');
 check(current.result.items[0].total_m===40&&current.result.items[0].order_quantity===46,'same product is summed and order quantity recomputed');
 check(current.notification_status==='accepted'&&notices===2,'concurrent resume attempts notify once');
 check(vision===3,'each image is parsed once despite concurrent resume calls');
 await resume(req('/api/analysis-jobs/'+second+'/resume','POST',{}),{params:{id:second}});await idle();check(notices===2,'reopening a completed job never duplicates accepted notification');
 check((await row("select count(*)::int n from usage_limits where line_user_id='local-owner'")).n===0,'admin remains unlimited without a quota reservation');
 check((await row('select count(*)::int n from analysis_worker_ticks')).n===tickCount,'interactive execution creates no fake scheduler heartbeat');
 check(JSON.stringify((await db.query('select line_user_id from users order by line_user_id')).rows)===JSON.stringify(oldIds),'all original user IDs are preserved');
 await db.query("select set_analysis_execution_mode('disabled')");const refused=await create(req('/api/analysis-jobs','POST',{image_paths:[firstPath]}));check(refused.status===503,'explicit operator stop still refuses work');
 const result={checks,visionCalls:vision,mockedLineAcceptances:notices,realLineSends:0,realAiCalls:0,closedMultipleImagesRequireResume:true,actualNextHttpEntryTested:false};fs.writeFileSync(path.join(root,'interactive-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,checks}));process.exitCode=1;}).finally(async()=>{
 await idle();global.fetch=savedFetch;globalThis[contextSymbol]=savedContext;names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});
 try{if(db._connected)await db.query('select set_analysis_execution_mode($1)',[previousMode]);}catch{}await db.end().catch(()=>{});
});
