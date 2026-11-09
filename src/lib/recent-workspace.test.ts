import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkspaceSwitch, switchWorkspaceDraft, listWorkspaceArchives, assertWorkspaceArchiveCurrent, readWorkspaceDraft, type WorkspaceDraft } from "./workspace-draft";
import { commitWorkspaceSwitch, restoreLatestWorkspaceSnapshot, saveLatestWorkspaceSnapshot, withWorkspaceLock } from "./latest-workspace";
import { resetResultDraft, restoreResultDraft, resumeResultDraft, resultAgePolicy, RESULT_DAY_MS } from "./result-session";
import { createLatestResultRecovery } from "./calculation/latest-result-recovery.mjs";
const A="00000000-0000-4000-8000-00000000000a",B="00000000-0000-4000-8000-00000000000b";
const draft=(id=A,q=60):WorkspaceDraft=>({version:1,siteName:"Next input",resultSiteName:id===A?"A":"B",resultJobId:id,parsed:{items:[{product_code:"SYN",manufacturer:"Synthetic",entries:[{original_formula:"20×1",length_m:20,quantity:1,subtotal_m:20,repeat_enabled:true,repeat_use_row_length:true}],total_m:20,order_quantity:q,manual_order_quantity:q}]},originalParsed:{items:[{product_code:"SYN",manufacturer:"Synthetic",entries:[],total_m:20,order_quantity:23}]},orderDraftItems:[{id:"mixed",productCode:"KEEP",quantity:7,unit:"m",sourceType:"manual",sourceLabel:"Synthetic"}]});
const store=()=>{const values=new Map<string,string>();let writes=0;return{values,get writes(){return writes;},get length(){return values.size;},key:(i:number)=>[...values.keys()][i]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{writes++;values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};};
const key="sokupa:workspace:v1:owner",latest="sokupa:latest-result:v1:owner";

test("screenshot-shaped four archives, same-ms/timeless/deferred/corrupt records remain byte-for-byte recoverable without mount writes",()=>{
 const s=store(),raws=[JSON.stringify({...draft(A,59),siteName:""}),JSON.stringify({...draft(A,59),siteName:"Named"}),JSON.stringify({...draft(A,59),siteName:""}),JSON.stringify({...draft(A,59),siteName:"Named"})];
 raws.forEach((raw,n)=>s.setItem(key+':recovery:'+['999-x:0','999-x:1','1000-y:0','1000-y:1'][n],raw));s.setItem(key+':recovery:result:'+B,JSON.stringify(draft(B,23)));s.setItem(key+':recovery:unknown-uuid','broken original bytes');s.setItem('sokupa:workspace:v1:other:recovery:secret','another user');s.setItem(key,JSON.stringify(draft(A,60)));
 const before=new Map(s.values),writes=s.writes,list=listWorkspaceArchives(s,key);assert.equal(list.length,6);assert.equal(s.writes,writes);assert.deepEqual(s.values,before);assert.equal(list.filter(a=>a.kind==='legacy').length,4);assert.equal(list.filter(a=>a.kind==='deferred').length,1);assert.equal(list.filter(a=>a.kind==='quarantine').length,1);assert.ok(list.every(a=>a.kind!=='recent'));
 const current=readWorkspaceDraft(s.getItem(key)!);switchWorkspaceDraft(s,key,s.getItem(key),current,draft(B,23));const next=listWorkspaceArchives(s,key);assert.equal(next.filter(a=>a.kind==='recent').length,1);assert.equal(next.find(a=>a.kind==='recent')?.draft?.parsed?.items[0].order_quantity,60);for(const[k,v]of before)if(k!==key)assert.equal(s.getItem(k),v);
});

test("revision/source/owner assertions fence stale selections even when contents or wall time are identical",()=>{
 const s=store();s.setItem(key,JSON.stringify(draft()));const first=switchWorkspaceDraft(s,key,s.getItem(key),draft(),draft(B,23)),selection=listWorkspaceArchives(s,key)[0];
 const second=switchWorkspaceDraft(s,key,first.raw,first.draft,selection.draft!);assert.throws(()=>assertWorkspaceArchiveCurrent(s,key,selection));assert.throws(()=>assertWorkspaceArchiveCurrent(s,'other',selection));
 const current=listWorkspaceArchives(s,key)[0];assertWorkspaceArchiveCurrent(s,key,current);assert.equal(current.revision,2);assert.equal(readWorkspaceDraft(second.raw).recentDraft?.revision,2);
 s.setItem(key+':recovery:legacy',JSON.stringify(draft()));const legacy=listWorkspaceArchives(s,key).find(a=>a.kind==='legacy')!;s.setItem(legacy.key,JSON.stringify(draft(A,61)));assert.throws(()=>assertWorkspaceArchiveCurrent(s,key,legacy));
});

test("recent format rejects recursion, broken references, unsupported versions and revision overflow",()=>{
 const value=prepareWorkspaceSwitch(draft(),draft(B,23));for(const mutate of[(d:WorkspaceDraft)=>{d.recentDraft!.revision=0;},(d:WorkspaceDraft)=>{d.recentDraft!.raw=JSON.stringify(value);},(d:WorkspaceDraft)=>{d.recentDraft!.raw='bad';},(d:WorkspaceDraft)=>{d.version=1;}]){const copy=structuredClone(value);mutate(copy);assert.throws(()=>readWorkspaceDraft(JSON.stringify(copy)));}
 assert.doesNotThrow(()=>readWorkspaceDraft(JSON.stringify(draft())));assert.throws(()=>readWorkspaceDraft(JSON.stringify({...draft(),version:3})));assert.throws(()=>prepareWorkspaceSwitch({...value,recentDraft:{...value.recentDraft!,revision:Number.MAX_SAFE_INTEGER}},draft()));
});

test("snapshot keeps raw unfinished saved values without nested previous generations",()=>{
 const current=draft();current.parsed!.items[0].order_quantity_input='';current.parsed!.items[0].entries[0].length_input='';current.orderDraftItems[0].quantityInput='';
 const first=prepareWorkspaceSwitch(current,draft(B,23)),second=prepareWorkspaceSwitch(first,current),previous=readWorkspaceDraft(second.recentDraft!.raw);assert.equal(previous.version,1);assert.equal(previous.recentDraft,undefined);assert.equal(readWorkspaceDraft(first.recentDraft!.raw).parsed!.items[0].entries[0].length_input,'');assert.equal(readWorkspaceDraft(first.recentDraft!.raw).orderDraftItems[0].quantityInput,'');
});

test("save-verified current60m is required before asynchronous switch; old59m is never substituted",async()=>{
 const s=store(),saved=draft(A,59),edited=draft(A,60);s.setItem(key,JSON.stringify(saved));const before=s.writes;
 await assert.rejects(()=>commitWorkspaceSwitch(s,'owner',s.getItem(key),edited,draft(B,23),()=>{}),/保存中/);assert.equal(s.writes,before);assert.equal(edited.parsed!.items[0].order_quantity,60);
 s.setItem(key,JSON.stringify(edited));const switched=await commitWorkspaceSwitch(s,'owner',s.getItem(key),edited,draft(B,23),()=>{});assert.equal(readWorkspaceDraft(switched.draft.recentDraft!.raw).parsed!.items[0].order_quantity,60);
});

test("every mirror/primary write failure keeps the verified current and old previous, without removing sources",async()=>{
 for(const failAt of[1,2,3]){
  const s=store(),current=prepareWorkspaceSwitch(draft(A,59),draft(B,60));s.setItem(key,JSON.stringify(current));await saveLatestWorkspaceSnapshot(s,'owner',current);const primary=s.getItem(key),mirror=s.getItem(latest),old=new Map(s.values);let writes=0;
  const flaky={...s,setItem:(k:string,v:string)=>{if(++writes===failAt)throw Error('quota');s.setItem(k,v);}};
  await assert.rejects(()=>commitWorkspaceSwitch(flaky,'owner',primary,current,draft(A,59),()=>{}));assert.equal(s.getItem(key),primary);assert.equal(s.getItem(latest),mirror);assert.deepEqual(s.values,old);
 }
});

test("readback failures never claim a switch; committed active+previous remain recoverable after reload",async()=>{
 for(const failAt of[1,2,3]){
  const s=store(),current=prepareWorkspaceSwitch(draft(A,59),draft(B,60));s.setItem(key,JSON.stringify(current));await saveLatestWorkspaceSnapshot(s,'owner',current);const primary=s.getItem(key),mirror=s.getItem(latest);let writes=0,bad:string|null=null;
  const flaky={...s,setItem:(k:string,v:string)=>{s.setItem(k,v);if(++writes===failAt)bad=k;},getItem:(k:string)=>{if(bad===k){bad=null;return 'unverified';}return s.getItem(k);}};
  await assert.rejects(()=>commitWorkspaceSwitch(flaky,'owner',primary,current,draft(A,59),()=>{}));
  if(failAt<3){assert.equal(s.getItem(key),primary);assert.equal(s.getItem(latest),mirror);}else{const reloaded=readWorkspaceDraft(s.getItem(key)!);assert.equal(reloaded.resultJobId,A);assert.equal(readWorkspaceDraft(reloaded.recentDraft!.raw).parsed!.items[0].order_quantity,60);assert.deepEqual(await restoreLatestWorkspaceSnapshot(s,'owner'),reloaded);}
 }
});

test("hard-crash snapshots at each mirror/primary boundary retain current60m and source59m",async()=>{
 const s=store(),current=prepareWorkspaceSwitch(draft(A,59),draft(B,60));s.setItem(key,JSON.stringify(current));await saveLatestWorkspaceSnapshot(s,'owner',current);const snapshots:Map<string,string>[]=[];
 const instrumented={...s,setItem:(k:string,v:string)=>{s.setItem(k,v);snapshots.push(new Map(s.values));}};
 await commitWorkspaceSwitch(instrumented,'owner',s.getItem(key),current,draft(A,59),()=>{});assert.equal(snapshots.length,3);
 for(const values of snapshots){const active=readWorkspaceDraft(values.get(key)!);const all=[active,readWorkspaceDraft(active.recentDraft!.raw)];assert.ok(all.some(d=>d.parsed!.items[0].order_quantity===60));assert.ok(all.some(d=>d.parsed!.items[0].order_quantity===59));}
});

test("cross-tab changes during mirror persistence stop primary overwrite; other accounts stay untouched",async()=>{
 const s=store(),current=draft();s.setItem(key,JSON.stringify(current));s.setItem('sokupa:workspace:v1:other','private');const foreign=JSON.stringify(draft(B,77));let changed=false;
 const race={...s,setItem:(k:string,v:string)=>{s.setItem(k,v);if(k===latest&&!changed){changed=true;s.setItem(key,foreign);}}};
 await assert.rejects(()=>commitWorkspaceSwitch(race,'owner',JSON.stringify(current),current,draft(B,23),()=>{if(s.getItem(key)!==JSON.stringify(current))throw Error('changed');}));assert.equal(s.getItem(key),foreign);assert.equal(s.getItem('sokupa:workspace:v1:other'),'private');
});

test("mirror fallback preserves recent, full reset undo and24/48h independently, including empty current",async()=>{
 let current=prepareWorkspaceSwitch(await resumeResultDraft(draft(A,59),1000),await resumeResultDraft(draft(B,60),1000));const previous=current.recentDraft;
 const reset=resetResultDraft(current,1100);assert.deepEqual(reset.recentDraft,previous);assert.equal(reset.resultSession?.undo?.parsed?.items[0].order_quantity,60);
 const s=store();await saveLatestWorkspaceSnapshot(s,'owner',reset);const recovered=await restoreLatestWorkspaceSnapshot(s,'owner');assert.deepEqual(recovered,reset);
 current=await restoreResultDraft(recovered!,2000);assert.deepEqual(current.recentDraft,previous);assert.equal(resultAgePolicy(current.resultSession,2000+RESULT_DAY_MS),'confirm');const age=resetResultDraft(current,2000+2*RESULT_DAY_MS,'age');assert.deepEqual(age.recentDraft,previous);assert.deepEqual(age.orderDraftItems,current.orderDraftItems);
 const empty=prepareWorkspaceSwitch(current,{version:1,siteName:'Only input',parsed:null,originalParsed:null,resultJobId:null,orderDraftItems:[]});await saveLatestWorkspaceSnapshot(s,'owner',empty);assert.deepEqual(await restoreLatestWorkspaceSnapshot(s,'owner'),empty);
});

test("version1 mirror restores without writes; new mirror version fences an older writer",async()=>{
 const s=store(),locks={request:async(_n:string,_o:unknown,operation:()=>unknown)=>operation()};
 const old=createLatestResultRecovery({ownerId:'owner',storage:s,locks,maxBytes:4_000_000}),token=await old.begin('legacy');await old.complete(token.token!,{parsed:draft().parsed!,editorState:{originalParsed:draft().originalParsed,orderDraftItems:[]},context:{siteName:'A',resultJobId:A}});
 const raw=s.getItem(latest),before=s.writes;assert.ok(await restoreLatestWorkspaceSnapshot(s,'owner'));assert.equal(s.getItem(latest),raw);assert.equal(s.writes,before);
 await saveLatestWorkspaceSnapshot(s,'owner',prepareWorkspaceSwitch(draft(),draft(B,23)));const preserved=s.getItem(latest);assert.equal((await old.restore()).status,'blocked');assert.equal((await old.begin('old-writer')).status,'blocked');assert.equal(s.getItem(latest),preserved);
});

test("missing exclusive locks fail closed before any switch operation",async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(navigator,'locks');let called=false;Object.defineProperty(navigator,'locks',{value:undefined,configurable:true});
 try{await assert.rejects(()=>withWorkspaceLock(key,()=>{called=true;}),/同時保存/);assert.equal(called,false);}finally{if(descriptor)Object.defineProperty(navigator,'locks',descriptor);else Reflect.deleteProperty(navigator,'locks');}
});


test("combined-size overflow fails before replacing active or its existing previous",()=>{
 const s=store(),current=prepareWorkspaceSwitch(draft(),draft(B,60));s.setItem(key,JSON.stringify(current));const raw=s.getItem(key),large=draft();large.parsed!.notes='x'.repeat(3_000_000);const outgoing=structuredClone(current);outgoing.parsed!.notes='y'.repeat(3_000_000);
 assert.throws(()=>switchWorkspaceDraft(s,key,raw,outgoing,large),/大きすぎ/);assert.equal(s.getItem(key),raw);
});
