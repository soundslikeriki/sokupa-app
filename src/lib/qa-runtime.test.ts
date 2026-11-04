import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { qaHash, readQaRuntime, QaRuntimeError, syntheticQaVision, type QaBinding } from "./qa-runtime";
import { sendLineMessages } from "./line-notification";
import { parseMemoBody } from "./parseMemo";
import { createSupabaseAdmin } from "./supabaseAdmin";
import { GET as startLogin } from "../app/api/auth/line/route";
import { NextRequest } from "next/server";
import { authorize } from "./server-auth";
import { signToken, SESSION_COOKIE } from "./session-token";

const now = 1_790_000_000_000;
function fixture(at = now) {
  const env: Record<string,string> = { SOKUPA_QA_MODE:"synthetic-owner-v1", VERCEL_PROJECT_ID:"prj_SyntheticQa123",
    NEXT_PUBLIC_SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co", ADMIN_LINE_USER_ID:`U${"1".repeat(32)}`,
    LINE_LOGIN_CHANNEL_ID:"2999999999", LINE_LOGIN_REDIRECT_URI:"https://sokupa-synthetic-qa.vercel.app/api/auth/line/callback",
    SUPABASE_SERVICE_ROLE_KEY:"synthetic-service-only", SESSION_SECRET:"synthetic-session-only-0000000000000000", LINE_LOGIN_CHANNEL_SECRET:"synthetic-login-only" };
  const q: QaBinding = {version:1,projectId:env.VERCEL_PROJECT_ID!,dbRef:"abcdefghijklmnopqrst",ownerLineUserId:env.ADMIN_LINE_USER_ID!,lineLoginChannelId:env.LINE_LOGIN_CHANNEL_ID!,origin:"https://sokupa-synthetic-qa.vercel.app",issuedAt:at-1,expiresAt:at+90*60_000-1,
    serviceKeySha256:qaHash(env.SUPABASE_SERVICE_ROLE_KEY!),sessionSecretSha256:qaHash(env.SESSION_SECRET!),lineSecretSha256:qaHash(env.LINE_LOGIN_CHANNEL_SECRET!)};
  env.SOKUPA_QA_BINDING=JSON.stringify(q); return {env,q};
}
test("QA binding fails closed for partial, wrong, production and expired configuration",()=>{
  assert.equal(readQaRuntime({},now),null);
  const {env,q}=fixture(); assert.equal(readQaRuntime(env,now)?.projectId,q.projectId);
  for(const [key,value] of Object.entries({SOKUPA_QA_MODE:"",SOKUPA_QA_BINDING:"{}",VERCEL_PROJECT_ID:"prj_wrong",NEXT_PUBLIC_SUPABASE_URL:"https://yegdgginwcmvpzeiuags.supabase.co",ADMIN_LINE_USER_ID:`U${"2".repeat(32)}`,LINE_LOGIN_CHANNEL_ID:"2009808783",LINE_LOGIN_REDIRECT_URI:"https://sokupa-app.vercel.app/api/auth/line/callback",SUPABASE_SERVICE_ROLE_KEY:"other",SESSION_SECRET:"other",LINE_LOGIN_CHANNEL_SECRET:"other",GOOGLE_GENERATIVE_AI_API_KEY:"accidental-real-key",GEMINI_API_KEY:"x",OPENAI_API_KEY:"x",LINE_CHANNEL_ACCESS_TOKEN:"x"})) assert.throws(()=>readQaRuntime({...env,[key]:value},now),QaRuntimeError,key);
  for(const patch of [{projectId:"prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx"},{dbRef:"yegdgginwcmvpzeiuags"},{lineLoginChannelId:"2009808783"},{issuedAt:now+1},{expiresAt:now},{expiresAt:now+91*60_000},{origin:"http://sokupa-synthetic-qa.vercel.app"},{origin:"https://evil.example.test"}]) assert.throws(()=>readQaRuntime({...env,SOKUPA_QA_BINDING:JSON.stringify({...q,...patch})},now),QaRuntimeError);
  assert.equal(readQaRuntime(env,q.expiresAt-1)?.expiresAt,q.expiresAt);
  assert.throws(()=>readQaRuntime(env,q.expiresAt),QaRuntimeError);
});
test("synthetic providers never use fetch; expiry blocks DB and login before network",async()=>{
  const previous={...process.env}; const oldFetch=global.fetch; let fetches=0;
  try {
    const {env,q}=fixture(Date.now());
    for(const key of ["GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY","OPENAI_API_KEY","AI_GATEWAY_API_KEY","LINE_CHANNEL_ACCESS_TOKEN"])delete process.env[key];
    Object.assign(process.env,env); global.fetch=async()=>{fetches++;throw new Error("Unexpected external request");};
    let delay=0; const result=JSON.parse(await syntheticQaVision(q,async ms=>{delay=ms;}));
    assert.equal(delay,31_000);assert.equal(result.items[0].entries[0].length_m,20);
    mock.timers.enable({apis:["setTimeout"]});
    const pending=parseMemoBody({base64Image:"AA=="});mock.timers.tick(31_000);
    const parsed=await pending;assert.equal(parsed.status,200);assert.equal((await parsed.json()).data.items[0].total_m,20);
    mock.timers.reset();
    const other=signToken("session",`U${"2".repeat(32)}`,60);
    assert.equal((await authorize(new NextRequest(`${q.origin}/api/analysis-jobs`,{headers:{cookie:`${SESSION_COOKIE}=${other}`}}))).error?.status,403);
    await sendLineMessages(q.ownerLineUserId,[{type:"text",text:"synthetic"}],"00000000-0000-4000-8000-000000000001");
    await assert.rejects(sendLineMessages(`U${"2".repeat(32)}`,[{type:"text",text:"x"}],"id"),QaRuntimeError);
    await assert.rejects(syntheticQaVision(q,async()=>{process.env.SOKUPA_QA_BINDING=JSON.stringify({...q,expiresAt:Date.now()-1});}),QaRuntimeError);
    assert.equal(createSupabaseAdmin(),null);
    assert.equal((await startLogin(new NextRequest(`${q.origin}/api/auth/line`))).status,503);
    const response=await parseMemoBody({base64Image:"AA=="});assert.equal(response.status,503);assert.equal((await response.json()).failure.kind,"infrastructure");
    await assert.rejects(sendLineMessages(q.ownerLineUserId,[{type:"text",text:"x"}],"id"),QaRuntimeError);
    assert.equal(fetches,0);
  } finally { mock.timers.reset();global.fetch=oldFetch; for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous); }
});
