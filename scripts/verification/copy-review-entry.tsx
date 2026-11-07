// Actual-component synthetic fixture; never imported by application code.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrderList } from "../../src/components/OrderList";
import { inspectCopyReview, prepareCopyReviewConfirmation } from "../../src/lib/copy-review";
import type { MemoProductItem } from "../../src/types";

const state = window as any;
state.calls = [];
window.fetch = async (input, options) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  state.calls.push({ url, method: options?.method ?? "GET" });
  const id = /^\/api\/analysis-jobs\/([^/]+)$/.exec(url)?.[1];
  if (id) {
    if (state.holdMetadata && id.endsWith("a")) await new Promise(resolve => { state.releaseMetadata = resolve; });
    if (state.failMetadata) return new Response(JSON.stringify({ error: "Synthetic metadata refusal" }), { status: 403 });
    return new Response(JSON.stringify({ data: { id, total_images: id.endsWith("b") ? 1 : 2 } }), { status: 200 });
  }
  if (url === "/api/memo-corrections") return new Response(JSON.stringify({ success: true }), { status: 200 });
  throw new Error("Unapproved fixture request " + url);
};
function Fixture() {
  const [items, setItems] = useState<MemoProductItem[]>(() => {
    const items = structuredClone(state.seed);
    if (state.confirmed) for (const item of items) {
      const input = { item, rows: item.entries.map((entry: any,index: number) => ({ id: entry.source_row_id ?? `${item.product_code}:${index}`, length: entry.length_m, quantity: entry.quantity, active: false })), repeatCm: null, basis: "unconfirmed", match: "unconfirmed", lossRate: 15 };
      const context = { sourceJobId: null, siteName: "Synthetic", itemKey: item.product_code }, review = inspectCopyReview(input, context);
      const ack = prepareCopyReviewConfirmation(input, context, review.token)!;
      item.reading_review_confirmation = ack.readingReviewConfirmation; item.quantity_confirmation = ack.quantityConfirmation;
    }
    return items;
  });
  const [originals] = useState(() => structuredClone(items));
  const [job, setJob] = useState<string | null>(state.noJob ? null : "00000000-0000-4000-8000-00000000000a");
  const [site, setSite] = useState("Synthetic");
  useLayoutEffect(() => {
    state.items = items; state.job = job;
    state.change = (kind: string) => {
      if (kind === "restore") { setItems(structuredClone(originals)); return; }
      if (kind === "job") { setJob("00000000-0000-4000-8000-00000000000b"); return; }
      if (kind === "site") { setSite("Changed site"); return; }
      if (kind === "remove") { setItems(previous => previous.slice(0, -1)); return; }
      if (kind === "duplicate") { setItems(previous => [...previous, structuredClone(previous[0])]); return; }
      if (kind === "add") { setItems(previous => [...previous, { ...structuredClone(previous[0]), product_code: "ADDED", quantity_confirmation: undefined, reading_review_confirmation: undefined }]); return; }
      setItems(previous => previous.map((item,index) => index ? item : kind === "candidate" ? { ...item, reading_reviews: [{ reason: "新しい訂正候補", candidate_formulas: ["3×4"], source_image_index: 1 }] }
        : kind === "code" ? { ...item, product_code: "CHANGED" }
          : { ...item, entries: item.entries.map((entry,entryIndex) => entryIndex ? entry : kind === "image" ? { ...entry, source_image_index: 1 } : { ...entry, quantity: entry.quantity + 1 }) }));
    };
  }, [items,job,originals]);
  return <OrderList basicView={Boolean(state.basic)} items={items} sourceItems={originals} siteName={site}
    sourceJobId={state.basic ? null : job} readingReviewSourceJobId={job} onItemsChange={setItems} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
