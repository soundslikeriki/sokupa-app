import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFingerprint, readReplacementConsent, writeReplacementConsent, forgetReplacementConsent } from "./replacement-consent";
import type { WorkspaceDraft } from "./workspace-draft";
import { resumeResultDraft } from "./result-session";
test("clock observation does not revoke replacement consent while real edits or explicit reset do", async () => {
  const draft = await resumeResultDraft({version:1,siteName:"next",resultSiteName:"source",parsed:{items:[{product_code:"SYN",manufacturer:"Synthetic",entries:[],total_m:1,order_quantity:2}]},orderDraftItems:[]},1000);
  const expected = await workspaceFingerprint(draft), reopened = structuredClone(draft);
  reopened.resultSession!.observedAt = 2000;
  assert.equal(await workspaceFingerprint(reopened), expected);
  reopened.parsed!.items[0].order_quantity = 3;
  assert.notEqual(await workspaceFingerprint(reopened), expected);
  const hidden = structuredClone(draft); hidden.resultSession!.inactive = true; hidden.resultSession!.generation++;
  assert.notEqual(await workspaceFingerprint(hidden), expected);
});
test("replacement intent survives reload without storing a second full workspace", async () => {
  const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,raw:string)=>{data.set(key,raw);},removeItem:(key:string)=>{data.delete(key);}};
  const draft:WorkspaceDraft={version:1,siteName:"edited",parsed:null,orderDraftItems:[]};
  const a={jobId:"00000000-0000-4000-8000-000000000001",fingerprint:await workspaceFingerprint(draft)};
  writeReplacementConsent(storage,"verified-owner",a);assert.deepEqual(readReplacementConsent(storage,"verified-owner"),a);
  assert.ok(Array.from(data.values())[0].length<256);assert.notEqual(await workspaceFingerprint({...draft,siteName:"new edit"}),a.fingerprint);
  const b={...a,jobId:"00000000-0000-4000-8000-000000000002"};writeReplacementConsent(storage,"verified-owner",b);
  forgetReplacementConsent(storage,"verified-owner",a.jobId);assert.deepEqual(readReplacementConsent(storage,"verified-owner"),b);
  forgetReplacementConsent(storage,"verified-owner",b.jobId);assert.equal(data.size,0);
});
