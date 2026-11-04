// Verification-only server. Real native DB/Storage; shipped QA adapters, no fake provider fetches.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Disposable local stack required');
for(const f of ['.env','.env.local','.env.production','.env.production.local'])assert.ok(!fs.existsSync(f),'No environment files permitted');
const state=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}}).find(s=>s.env?.API_URL);
assert.equal(state.runtime,'native');assert.ok(['127.0.0.1','localhost'].includes(new URL(state.env.API_URL).hostname));
const env={VERCEL_PROJECT_ID:'prj_SyntheticQa123',NEXT_PUBLIC_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:state.env.SERVICE_ROLE_KEY,SESSION_SECRET:fs.readFileSync(path.join(root,'dispatch-key'),'utf8'),ADMIN_LINE_USER_ID:'U'+'1'.repeat(32),LINE_LOGIN_CHANNEL_ID:'2999999999',LINE_LOGIN_CHANNEL_SECRET:'synthetic-login-only',LINE_LOGIN_REDIRECT_URI:'https://sokupa-synthetic-qa.vercel.app/api/auth/line/callback',ANALYSIS_BACKGROUND_MODE:'scheduled-wake',ANALYSIS_WAKE_ENABLED:'true',SOKUPA_QA_MODE:'synthetic-owner-v1'};
const hash=s=>createHash('sha256').update(s).digest('hex');
const q={version:1,projectId:env.VERCEL_PROJECT_ID,dbRef:'abcdefghijklmnopqrst',ownerLineUserId:env.ADMIN_LINE_USER_ID,lineLoginChannelId:env.LINE_LOGIN_CHANNEL_ID,origin:'https://sokupa-synthetic-qa.vercel.app',issuedAt:Date.now()-1000,expiresAt:Date.now()+80*60000,serviceKeySha256:hash(env.SUPABASE_SERVICE_ROLE_KEY),sessionSecretSha256:hash(env.SESSION_SECRET),lineSecretSha256:hash(env.LINE_LOGIN_CHANNEL_SECRET)};
Object.assign(process.env,env,{SOKUPA_QA_BINDING:JSON.stringify(q)});
for(const key of ['GEMINI_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','OPENAI_API_KEY','AI_GATEWAY_API_KEY','LINE_CHANNEL_ACCESS_TOKEN'])delete process.env[key];
const event=type=>fs.appendFileSync(path.join(root,'qa-next-events.jsonl'),JSON.stringify({type,at:new Date().toISOString()})+'\n',{mode:0o600});
const info=console.info;console.info=(...args)=>{
 if(args[0]==='[parse-memo] timing'&&args[1]?.stage==='vision'){assert.equal(args[1].synthetic,true);event('shipped_qa_vision_completed');}
 if(args[0]==='[qa] synthetic notification accepted')event('shipped_qa_notification_accepted');
 info(...args);
};
const original=global.fetch;global.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.hostname==='abcdefghijklmnopqrst.supabase.co'){
  const target=new URL(url.pathname+url.search,state.env.API_URL);
  return original(input instanceof Request?new Request(target,input):target,{...init,redirect:'error'});
 }
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Any real provider or nonlocal request is forbidden');
 return original(input,{...init,redirect:'error'});
};
globalThis[Symbol.for('@vercel/request-context')]={get:()=>({waitUntil:p=>{event('wait_until_registered');p.then(()=>event('wait_until_finished'),()=>event('wait_until_failed'));}})};
let handler;const server=https.createServer({key:fs.readFileSync(path.join(root,'tls/key.pem')),cert:fs.readFileSync(path.join(root,'tls/cert.pem'))},(req,res)=>{
 const mode=fs.readFileSync(path.join(root,'qa-next-mode'),'utf8').trim();
 process.env.SOKUPA_QA_BINDING=JSON.stringify(mode==='expired'?{...q,expiresAt:Date.now()-1}:q);
 if(req.url==='/api/analysis-jobs/wake'&&mode==='401'){res.writeHead(401);res.end();return;}
 req.headers['x-forwarded-proto']='https';if(handler)return handler(req,res);res.writeHead(503);res.end();
});
(async()=>{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port,app=require('next')({dev:false,hostname:'localhost',port});await app.prepare();handler=app.getRequestHandler();
 console.log(JSON.stringify({local_qa_next_ready:true,origin:`https://localhost:${port}`}));
 const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
})().catch(e=>{console.error(e.message);process.exit(1);});
