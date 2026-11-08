import test from "node:test";
import assert from "node:assert/strict";
import { notificationWatchesForDisplay, notificationRetryable, analysisBlocksIntake, mergeNotificationWatch, forgetJobPointerIfMatches, needsAnalysisRestoration, type NotificationWatch } from "./notification-watch";

test("old notification updates cannot erase another job or downgrade a terminal outcome", () => {
  const a = { jobId: "a", siteName: "A", status: "failed", error: "outage" }, b = { jobId: "b", siteName: "B", status: "pending" };
  let watches = mergeNotificationWatch([a], b);
  watches = mergeNotificationWatch(watches, { ...a, status: "accepted", error: null });
  assert.equal(watches.find((watch) => watch.jobId === "b")?.status, "pending");
  watches = mergeNotificationWatch(watches, a);
  assert.equal(watches.find((watch) => watch.jobId === "a")?.status, "accepted");
  assert.equal(notificationRetryable("accepted"), false); assert.equal(notificationRetryable("uncertain"), false);
  assert.equal(notificationRetryable("legacy_unknown"), false); assert.equal(notificationRetryable("failed"), true);
});

test("terminal display history is bounded without discarding pending notifications", () => {
  let watches: NotificationWatch[] = [{ jobId: "pending", siteName: "P", status: "failed" }];
  for (let i = 0; i < 15; i++) watches = mergeNotificationWatch(watches, { jobId: String(i), siteName: "T", status: "accepted" });
  assert.equal(watches.length, 11); assert.ok(watches.some((watch) => watch.jobId === "pending"));
});

test("finishing notification A never removes the pointer for new analysis B", () => {
  const values = new Map([["sokupa:lastJobId:owner", "b"], ["sokupa:lastJobId", "a"], ["sokupa:lastJobId:another", "a"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
  forgetJobPointerIfMatches(storage, "owner", "a");
  assert.equal(values.get("sokupa:lastJobId:owner"), "b"); assert.equal(values.has("sokupa:lastJobId"), false); assert.equal(values.get("sokupa:lastJobId:another"), "a");
  forgetJobPointerIfMatches(storage, "owner", "b"); assert.equal(values.has("sokupa:lastJobId:owner"), false);
});

test("remote seen receipts never discard an explicit device pointer", () => {
  assert.equal(needsAnalysisRestoration({ status: "done", client_result_seen_at: "stored" }), false);
  assert.equal(needsAnalysisRestoration({ status: "done", client_result_seen_at: "stored" }, true), true);
  assert.equal(needsAnalysisRestoration({ status: "done", client_result_seen_at: null }), true);
  assert.equal(needsAnalysisRestoration({ status: "running", client_result_seen_at: "stored" }), true);
  assert.equal(needsAnalysisRestoration({ status: "done" }), true);
});

test("only unfinished analysis blocks intake, regardless of notification waiting", () => {
  assert.equal(analysisBlocksIntake(null), false);
  for (const status of ["queued", "running", undefined, "unknown"]) assert.equal(analysisBlocksIntake({ status }), true);
  for (const status of ["done", "failed"]) assert.equal(analysisBlocksIntake({ status }), false);
});


test("notification display uses associated job IDs without changing hidden terminal/retry records", () => {
  const watches:NotificationWatch[] = [
    {jobId:"old-a",siteName:"Old A",status:"uncertain"},
    {jobId:"old-b",siteName:"Old B",status:"failed",error:"offline"},
    {jobId:"new",siteName:"New C",status:"pending"},
  ];
  const before=JSON.stringify(watches);
  assert.deepEqual(notificationWatchesForDisplay(watches,[]),[]);
  assert.deepEqual(notificationWatchesForDisplay(watches,[null,undefined,"new"]).map(w=>w.jobId),["new"]);
  assert.deepEqual(notificationWatchesForDisplay(watches,["old-a"]).map(w=>w.jobId),["old-a"]);
  assert.deepEqual(notificationWatchesForDisplay(watches,["old-a","new","new"]).map(w=>w.jobId),["old-a","new"]);
  assert.equal(JSON.stringify(watches),before);
  assert.equal(notificationRetryable(watches[1].status),true);
});
