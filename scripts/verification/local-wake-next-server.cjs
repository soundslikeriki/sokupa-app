// Real Next HTTP entry, local TLS and synthetic provider responses. Never a deployment server.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict');
const root=process.env.SOKUPA_LOCAL_STACK_ROOT;
if(!root||!path.basename(root).startsWith('sokupa-real-supabase-'))throw Error('Disposable local root required');
for(const name of ['.env','.env.local','.env.production','.env.production.local'])if(fs.existsSync(name))throw Error('Refuse environment files in the local fixture checkout');
const state=fs.readFileSync(path.join(root,'start.log'),'utf8').split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).find(x=>x.env?.API_URL);
assert.equal(state.runtime,'native');assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(state.env.API_URL).hostname));
Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:state.env.API_URL,SUPABASE_SERVICE_ROLE_KEY:state.env.SERVICE_ROLE_KEY,SESSION_SECRET:fs.readFileSync(path.join(root,'dispatch-key'),'utf8'),ADMIN_LINE_USER_ID:'local-owner',ANALYSIS_BACKGROUND_MODE:'scheduled-wake',ANALYSIS_WAKE_ENABLED:'true',GEMINI_API_KEY:'synthetic-only',GOOGLE_GENERATIVE_AI_API_KEY:'synthetic-only',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-only'});
const event=(type)=>fs.appendFileSync(path.join(root,'wake-next-events.jsonl'),JSON.stringify({type,at:new Date().toISOString()})+'\n',{mode:0o600});
const original=global.fetch;
global.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.hostname==='generativelanguage.googleapis.com'){
  event('synthetic_vision_started');await new Promise(r=>setTimeout(r,31000));event('synthetic_vision_finished');
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:JSON.stringify({items:[{product_code:'LOCAL',entries:[{original_formula:'20×1',length_m:20,quantity:1}]}]})}]},finishReason:'STOP'}]}),{headers:{'Content-Type':'application/json'}});
 }
 if(url.hostname==='api.line.me'){
  assert.equal(url.pathname,'/v2/bot/message/push');assert.equal(JSON.parse(init.body).to,'local-owner');event('synthetic_line_accepted');
  return new Response('{}',{headers:{'Content-Type':'application/json'}});
 }
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Nonlocal traffic refused by local Next fixture');return original(input,{...init,redirect:'error'});
};
globalThis[Symbol.for('@vercel/request-context')]={get:()=>({waitUntil:p=>{event('wait_until_registered');p.then(()=>event('wait_until_finished'),()=>event('wait_until_failed'));}})};
let handler;const server=https.createServer({key:fs.readFileSync(path.join(root,'tls/key.pem')),cert:fs.readFileSync(path.join(root,'tls/cert.pem'))},(req,res)=>{
 if(req.url==='/api/analysis-jobs/wake'){
  const mode=fs.readFileSync(path.join(root,'wake-next-mode'),'utf8').trim();
  if(mode==='401'){res.writeHead(401);res.end();return;}
  if(mode==='redirect'){res.writeHead(302,{Location:'/local-login'});res.end();return;}
 }
 if(req.url==='/local-login'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>synthetic local login</html>');return;}
 req.headers['x-forwarded-proto']='https';if(handler)return handler(req,res);res.writeHead(503);res.end();
});
(async()=>{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port,app=require('next')({dev:false,hostname:'localhost',port});await app.prepare();handler=app.getRequestHandler();
 console.log(JSON.stringify({local_wake_next_ready:true,origin:`https://localhost:${port}`}));
 const shutdown=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
})().catch(e=>{console.error(e.message);process.exit(1)});
