import test from "node:test";
import assert from "node:assert/strict";
import { activateResultSession, allowResultJob, commitResultTransition, hasUnfinishedResultInput, isObservationOnlyChange, resetResultDraft, restoreResultDraft, resultAgePolicy, resultMayApply, resumeResultDraft, stampResultSession, RESULT_DAY_MS } from "./result-session";
import { readWorkspaceDraft, type WorkspaceDraft } from "./workspace-draft";
import { restoreLatestWorkspaceSnapshot, saveLatestWorkspaceSnapshot } from "./latest-workspace";

const jobA = "00000000-0000-4000-8000-00000000000a", jobB = "00000000-0000-4000-8000-00000000000b";
const draft = (): WorkspaceDraft => ({ version: 1, siteName: "Next B", resultSiteName: "Result A", resultJobId: jobA,
  parsed: { items: [{ product_code: "SYN", manufacturer: "Synthetic", entries: [{ original_formula: "20x1", length_m: 20, quantity: 1, subtotal_m: 20, repeat_use_row_length: true }], total_m: 20, order_quantity: 23, quantity_confirmation: "quantity", reading_review_confirmation: "reading" }] },
  orderDraftItems: [{ id: "draft", productCode: "KEEP", quantity: 3, unit: "m", sourceLabel: "Synthetic", sourceType: "manual" }] });
const storage = () => { const data = new Map<string,string>(); return { data, getItem: (key:string) => data.get(key) ?? null, setItem: (key:string,value:string) => { data.set(key,value); }, removeItem: (key:string) => { data.delete(key); } }; };

test("saved unfinished input is protected before an editor can report its state", () => {
  assert.equal(hasUnfinishedResultInput(draft()), false);
  for (const key of ["order_quantity_input", "repeat_cm_input", "repeat_height_input", "loss_rate_input"] as const) {
    const next = draft(); next.parsed!.items[0][key] = ""; assert.equal(hasUnfinishedResultInput(next), true);
  }
  for (const key of ["length_input", "quantity_input"] as const) {
    const next = draft(); next.parsed!.items[0].entries[0][key] = "-"; assert.equal(hasUnfinishedResultInput(next), true);
  }
});

test("only forward observation metadata can merge across tabs; all real state changes remain conflicts", async () => {
  const current = await resumeResultDraft(draft(), 1000), observed = structuredClone(current);
  observed.resultSession!.observedAt = 2000;
  const raw = JSON.stringify(current);
  assert.equal(isObservationOnlyChange(raw, JSON.stringify(observed)), true);
  for (const mutate of [
    (d: WorkspaceDraft) => { d.siteName = "changed next input"; },
    (d: WorkspaceDraft) => { d.resultSiteName = "changed result source"; },
    (d: WorkspaceDraft) => { d.parsed!.items[0].order_quantity++; },
    (d: WorkspaceDraft) => { d.resultSession!.generation++; },
    (d: WorkspaceDraft) => { d.resultSession!.meaningfulAt = 2000; },
    (d: WorkspaceDraft) => { d.resultSession!.observedAt = 900; },
  ]) { const changed = structuredClone(observed); mutate(changed); assert.equal(isObservationOnlyChange(raw, JSON.stringify(changed)), false); }
  assert.equal(isObservationOnlyChange(raw, "broken"), false);
  assert.equal(isObservationOnlyChange(null, JSON.stringify(observed)), false);
});

test("0/24/48 hour boundaries use meaningful time, never mirror updatedAt", async () => {
  const current = await resumeResultDraft(draft(), 1000);
  assert.equal(resultAgePolicy(current.resultSession, 1000), "show");
  assert.equal(resultAgePolicy(current.resultSession, 1000 + RESULT_DAY_MS - 1), "show");
  assert.equal(resultAgePolicy(current.resultSession, 1000 + RESULT_DAY_MS), "confirm");
  assert.equal(resultAgePolicy(current.resultSession, 1000 + 2 * RESULT_DAY_MS - 1), "confirm");
  assert.equal(resultAgePolicy(current.resultSession, 1000 + 2 * RESULT_DAY_MS), "hide");
});

test("legacy, missing, malformed, future and backwards clocks require confirmation", async () => {
  const current = await resumeResultDraft(draft(), 1000);
  assert.equal(resultAgePolicy(undefined, 1000), "confirm");
  for (const value of [undefined, null, "bad", -1, 9000]) assert.equal(resultAgePolicy({ ...current.resultSession!, meaningfulAt: value }, 2000), "confirm");
  assert.equal(resultAgePolicy({ ...current.resultSession!, observedAt: 3000 }, 2000), "confirm");
  assert.equal(resultAgePolicy(current.resultSession, Number.NaN), "confirm");
});

test("opening, normalization, next-input site and order drafts never renew the clock", async () => {
  const current = await resumeResultDraft(draft(), 1000);
  const viewed = await stampResultSession(current, 2000, false);
  assert.equal(viewed.resultSession?.meaningfulAt, 1000);
  const next = await stampResultSession({ ...viewed, siteName: "Next C", orderDraftItems: [] }, 3000, true);
  assert.equal(next.resultSession?.meaningfulAt, 1000);
  const normalized = structuredClone(next); normalized.parsed!.items[0].memo_allowance = "add";
  assert.equal((await stampResultSession(normalized, 4000, false)).resultSession?.meaningfulAt, 1000);
});

test("an actual saved edit renews once, and a backwards clock fails conservatively", async () => {
  const current = await resumeResultDraft(draft(), 1000);
  current.parsed!.items[0].manual_order_quantity = 30;
  const edited = await stampResultSession(current, 2000, true);
  assert.equal(edited.resultSession?.meaningfulAt, 2000);
  assert.equal((await stampResultSession(edited, 3000, true)).resultSession?.meaningfulAt, 2000);
  edited.parsed!.items[0].manual_order_quantity = 31;
  assert.equal(resultAgePolicy((await stampResultSession(edited, 1500, true)).resultSession, 1500), "confirm");
});

test("manual reset wins over a recent timestamp and preserves result-only data", async () => {
  const current = await resumeResultDraft(draft(), 1000), reset = resetResultDraft(current, 1100);
  assert.equal(reset.parsed, null); assert.equal(reset.resultJobId, null);
  assert.equal(reset.siteName, "Next B"); assert.deepEqual(reset.orderDraftItems, current.orderDraftItems);
  assert.equal(resultAgePolicy(reset.resultSession, 1200), "inactive");
  assert.equal(reset.resultSession?.undo?.resultSiteName, "Result A");
  assert.deepEqual(reset.resultSession?.undo?.parsed, current.parsed);
  current.parsed!.items[0].entries[0].quantity = 99;
  assert.equal(reset.resultSession?.undo?.parsed.items[0].entries[0].quantity, 1);
});

test("one undo is replaced by the next reset and consumed by explicit restore", async () => {
  const resetA = resetResultDraft(await resumeResultDraft(draft(), 1000), 1100);
  const resultB = { ...resetA, parsed: structuredClone(draft().parsed), resultSiteName: "Result B", resultJobId: jobB, resultSession: activateResultSession(resetA.resultSession) };
  const resetB = resetResultDraft(resultB, 2000);
  assert.equal(resetB.resultSession?.undo?.resultJobId, jobB);
  const restored = await restoreResultDraft(resetB, 3000);
  assert.equal(restored.resultJobId, jobB); assert.equal(restored.resultSiteName, "Result B");
  assert.equal(restored.siteName, "Next B"); assert.equal(restored.resultSession?.undo, null);
  assert.equal(restored.resultSession?.meaningfulAt, 3000);
  assert.equal(resultAgePolicy(restored.resultSession, 3000 + RESULT_DAY_MS - 1), "show");
  await assert.rejects(() => restoreResultDraft(restored, 4000));
});

test("restore retains confirmations/dimensions and preserves a newer input name and draft", async () => {
  const reset = resetResultDraft(await resumeResultDraft(draft(), 1000), 1100);
  reset.siteName = "New next input"; reset.orderDraftItems[0].quantity = 9;
  const restored = await restoreResultDraft(reset, 2000);
  assert.equal(restored.siteName, "New next input"); assert.equal(restored.resultSiteName, "Result A");
  assert.equal(restored.orderDraftItems[0].quantity, 9);
  assert.equal(restored.parsed!.items[0].quantity_confirmation, "quantity");
  assert.equal(restored.parsed!.items[0].entries[0].repeat_use_row_length, true);
});

test("inactive display permits only a newly explicit job, not late discovery", async () => {
  const reset = resetResultDraft(await resumeResultDraft(draft(), 1000), 1100);
  assert.equal(resultMayApply(reset.resultSession, jobA), false);
  const allowed = allowResultJob(reset.resultSession, jobB);
  assert.equal(resultMayApply(allowed, jobA), false); assert.equal(resultMayApply(allowed, jobB), true);
  assert.equal(resultMayApply(activateResultSession(allowed), jobB), true);
});

test("reset mirror fallback stays inactive with its one undo after primary loss", async () => {
  const store = storage(), reset = resetResultDraft(await resumeResultDraft(draft(), 1000), 1100);
  await saveLatestWorkspaceSnapshot(store, "owner", reset);
  const recovered = await restoreLatestWorkspaceSnapshot(store, "owner");
  assert.equal(recovered?.parsed, null); assert.equal(recovered?.resultSession?.inactive, true);
  assert.deepEqual(recovered?.resultSession?.undo?.parsed, reset.resultSession?.undo?.parsed);
});

test("transition errors retain the old primary and undo; another owner stays unchanged", async () => {
  for (const failAt of [1, 2, 3]) {
    const store = storage(), current = await resumeResultDraft(draft(), 1000), key = "sokupa:workspace:v1:owner";
    store.setItem(key, JSON.stringify(current)); store.setItem("sokupa:workspace:v1:other", "private-other");
    const before = store.getItem(key); let writes = 0;
    const flaky = { ...store, setItem: (k:string,v:string) => { if (++writes === failAt) throw Error("quota"); store.setItem(k,v); } };
    await assert.rejects(() => commitResultTransition(flaky, "owner", before, resetResultDraft(current, 2000)));
    assert.equal(store.getItem(key), before); assert.equal(store.getItem("sokupa:workspace:v1:other"), "private-other");
  }
});

test("a competing primary is never rolled back or overwritten", async () => {
  const store = storage(), current = await resumeResultDraft(draft(), 1000), key = "sokupa:workspace:v1:owner";
  store.setItem(key, JSON.stringify(current)); const before = store.getItem(key);
  const competing = { ...store, setItem: (k:string,v:string) => { store.setItem(k,v); if (k.includes("latest-result")) store.setItem(key, "newer-foreign-tab"); } };
  await assert.rejects(() => commitResultTransition(competing, "owner", before, resetResultDraft(current, 2000)));
  assert.equal(store.getItem(key), "newer-foreign-tab");
});

test("session/undo schema rejects broken references while unknown time stays confirmable", async () => {
  const reset = resetResultDraft(await resumeResultDraft(draft(), 1000), 1100);
  const broken = structuredClone(reset); broken.resultSession!.undo!.resultJobId = "bad";
  assert.throws(() => readWorkspaceDraft(JSON.stringify(broken)));
  reset.resultSession!.meaningfulAt = "unknown";
  assert.doesNotThrow(() => readWorkspaceDraft(JSON.stringify(reset)));
});
