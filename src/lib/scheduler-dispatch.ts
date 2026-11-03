import {createHmac,timingSafeEqual} from "node:crypto";
import {UUID_PATTERN} from "@/lib/memo-storage";

export type SchedulerDispatch={id:string;issuedAt:number;expiresAt:number};
/** Only the fixed scheduled GET endpoint can use this key; never a login/admin credential. */
export function verifySchedulerDispatch(req:Request,now=Math.floor(Date.now()/1000)):SchedulerDispatch|null{
  const key=process.env.ANALYSIS_DISPATCH_SECRET,configured=process.env.ANALYSIS_DISPATCH_ORIGIN;
  if(!key||Buffer.byteLength(key)<32||!configured)return null;
  let origin:string,url:URL;
  try{const canonical=configured.replace(/:443$/,"");const target=new URL(canonical);if(target.protocol!=="https:"||target.origin!==canonical)return null;origin=target.origin;url=new URL(req.url);}catch{return null;}
  if(req.method!=="GET"||url.origin!==origin||url.pathname!=="/api/analysis-jobs/process"||url.search)return null;
  const id=req.headers.get("x-sokupa-dispatch-id")??"",issued=req.headers.get("x-sokupa-issued-at")??"",expires=req.headers.get("x-sokupa-expires-at")??"",signature=req.headers.get("x-sokupa-signature")??"";
  if(!UUID_PATTERN.test(id)||!/^\d{10}$/.test(issued)||!/^\d{10}$/.test(expires)||!/^[0-9a-f]{64}$/.test(signature))return null;
  const issuedAt=Number(issued),expiresAt=Number(expires);
  if(issuedAt>now+15||issuedAt<now-120||expiresAt<=now||expiresAt-issuedAt<1||expiresAt-issuedAt>120)return null;
  const canonical=["SOKUPA-DISPATCH-V1","GET",origin,"/api/analysis-jobs/process",id,issued,expires].join("\n");
  const expected=createHmac("sha256",key).update(canonical).digest(),actual=Buffer.from(signature,"hex");
  return timingSafeEqual(expected,actual)?{id,issuedAt,expiresAt}:null;
}
