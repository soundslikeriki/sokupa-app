// Explicitly invoked private test only. Never imports the app server, Supabase,
// job processor or LINE. The existing single key stays inside an anonymous pipe
// and this short-lived process, never a command argument, file or console output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ts=createRequire(import.meta.url)('typescript');
const source=fs.readFileSync(path.join(repo,'src/lib/parseMemo.ts'),'utf8');
const ast=ts.createSourceFile('parseMemo.ts',source,ts.ScriptTarget.Latest,true);
const constants={};
const visit=node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&['VISION_MODEL','SYSTEM_PROMPT'].includes(node.name.text)&&node.initializer&&(ts.isStringLiteral(node.initializer)||ts.isNoSubstitutionTemplateLiteral(node.initializer)))constants[node.name.text]=node.initializer.text;ts.forEachChild(node,visit);};visit(ast);
if(constants.VISION_MODEL!=='gemini-3-flash-preview'||constants.SYSTEM_PROMPT?.length<1000)throw Error('Unexpected model/prompt; review before any call');
const [mode,imagePath,outPath]=process.argv.slice(2);
if(!['--dry-run','--execute-once'].includes(mode)||!imagePath||!outPath)throw Error('Explicit mode/image/private output directory required');
const out=path.resolve(outPath),image=fs.readFileSync(imagePath);
if(!out.startsWith(path.resolve(repo,'..')+path.sep)||image.length>1000000||image[0]!==255||image[1]!==216)throw Error('Explicit local JPEG/private output required');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${constants.VISION_MODEL}:generateContent`;
const body={contents:[{role:'user',parts:[{text:constants.SYSTEM_PROMPT},{inlineData:{mimeType:'image/jpeg',data:image.toString('base64')}}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json',maxOutputTokens:8192}};
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const meta={model:constants.VISION_MODEL,endpoint,imageSha256:digest(image),promptSha256:digest(constants.SYSTEM_PROMPT),maxOutputTokens:8192,grounding:false,automaticRetries:0,productionDatabaseAccess:false,productionStorageAccess:false,historyWrites:0,lineSends:0,conservativeFullModelTokenCostCeilingUsd:.720896};
const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
if(mode==='--dry-run'){
  if(Object.keys(body).join(',')!=='contents,generationConfig'||body.contents.length!==1)throw Error('Unexpected request shape');
  write('provider-isolation-dry-run.json',{...meta,networkRequests:0,credentialReads:0,ready:true});console.log(JSON.stringify({...meta,dryRun:true,networkRequests:0}));
}else{
  const marker=path.join(out,'provider-attempt.json');
  fs.writeFileSync(marker,JSON.stringify({...meta,state:'preparing-key',startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
  const env={PATH:process.env.PATH,HOME:process.env.HOME,VERCEL_TELEMETRY_DISABLED:'1'};
  const keyResult=spawnSync('/opt/homebrew/bin/vercel',['api','/v1/projects/prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx/env/h10lSpDYPLg2ZFAd?teamId=team_KOlFnguSk3s5yqYmQmvZCehz','--method','GET','--raw','--non-interactive','--yes'],{cwd:repo,env,encoding:'utf8',timeout:30000,maxBuffer:100000});
  let record;try{record=JSON.parse(keyResult.stdout);}catch{}
  if(keyResult.status!==0||record?.key!=='GOOGLE_GENERATIVE_AI_API_KEY'||typeof record.value!=='string'||record.value.length<20){write('provider-attempt.json',{...meta,state:'key-not-obtained',providerCalls:0,cliExit:keyResult.status,reason:record?.reason??record?.error?.code??'unexpected-response'});throw Error('Existing single-key read did not complete; no provider call made');}
  let key=record.value;record.value='';keyResult.stdout='';
  let calls=0;const transport=globalThis.fetch;
  globalThis.fetch=(url,init)=>{if(url!==endpoint||init?.method!=='POST'||++calls!==1)throw Error('Non-provider or repeated request blocked');return transport(url,{...init,redirect:'error'});};
  write('provider-attempt.json',{...meta,state:'provider-request-starting',providerCalls:1,startedAt:new Date().toISOString()});
  try{
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(210000)});
    key='';const result=await response.json();
    if(!response.ok){write('provider-attempt.json',{...meta,state:'provider-http-error',providerCalls:calls,httpStatus:response.status,code:result.error?.status,completedAt:new Date().toISOString()});throw Error('Provider returned an error; automatic retry prohibited');}
    write('provider-response-private.json',result);
    const text=(result.candidates?.[0]?.content?.parts??[]).filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');
    fs.writeFileSync(path.join(out,'provider-text-private.json'),text,{mode:0o600});
    let valid=false;try{const parsed=JSON.parse(text);valid=Array.isArray(parsed.items)&&parsed.items.length>0;}catch{}
    const usage=result.usageMetadata??{};
    const estimatedUsd=((usage.promptTokenCount??0)*.5+((usage.candidatesTokenCount??0)+(usage.thoughtsTokenCount??0))*3)/1000000;
    const complete=valid&&result.candidates?.[0]?.finishReason==='STOP';
    const summary={...meta,state:complete?'response-saved':'incomplete-response-saved',providerCalls:calls,httpStatus:response.status,usage,estimatedUsd,finishReason:result.candidates?.[0]?.finishReason,responseSha256:digest(JSON.stringify(result)),completedAt:new Date().toISOString()};
    write('provider-attempt.json',summary);console.log(JSON.stringify(summary));
    if(!complete)process.exitCode=1;
  }catch(error){key='';const state=JSON.parse(fs.readFileSync(marker,'utf8'));if(state.state==='provider-request-starting')write('provider-attempt.json',{...state,state:'delivery-unknown',errorName:error.name,automaticRetry:false});throw Error('One provider attempt ended; inspect saved status before any further action');}
}
