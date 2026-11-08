// Isolated actual-component fixture. All fetch responses and data are synthetic.
import React, { useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrderList } from "../../src/components/OrderList";
import { WorkspaceModeMenu, type CalculationMode } from "../../src/components/WorkspaceModeMenu";
import type { MemoProductItem } from "../../src/types";

const state = window as any;
state.calls = [];
window.fetch = async (input, options) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  state.calls.push({ url, method: options?.method ?? "GET", body: options?.body });
  if (url === "/api/memo-corrections") {
    if (state.holdCorrection) await new Promise<void>(resolve => { state.releaseCorrection = resolve; });
    if (state.failCorrection) throw new Error("Synthetic correction transport failure");
    if (state.correctionStatus) return new Response("{}", { status: state.correctionStatus });
  }
  return new Response(JSON.stringify({ success: true, data: { id: "00000000-0000-4000-8000-00000000000a", total_images: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } });
};
function Fixture() {
  const [job, setJob] = useState("00000000-0000-4000-8000-00000000000a");
  const [mode, setMode] = useState<CalculationMode>("dimensions");
  const [items, setItems] = useState<MemoProductItem[]>([{
    product_code: "SYNA", manufacturer: "Synthetic", measurement_basis: "trim-included", pattern_match: "straight", repeat_cm: 60,
    entries: [{ source_row_id: "r0", source_image_index: 0, source_entry_index: 0, original_formula: "2.7×2", length_m: 2.7, quantity: 2, subtotal_m: 5.4 }, { source_row_id: "r1", source_image_index: 1, source_entry_index: 0, original_formula: "3.8×1", length_m: 3.8, quantity: 1, subtotal_m: 3.8 }],
    total_m: 9.2, order_quantity: 11,
    reading_reviews: [{ reason: "Synthetic correction", candidate_formulas: ["1×2"], source_image_index: 0 }],
  }]);
  useLayoutEffect(() => { state.items = items; }, [items]);
  useLayoutEffect(() => { state.replaceResult = (nextJob: string, next: MemoProductItem[]) => { setJob(nextJob); setItems(next); }; }, []);
  const update = useCallback((next: MemoProductItem[]) => { (state.updates ??= []).push(next.map(item => item.product_code)); setItems(next); }, []);
  return <>
    <WorkspaceModeMenu value={mode} count={0} onChange={setMode} />
    <div hidden={mode !== "dimensions"}>
      <OrderList key={job} items={items} sourceJobId={state.basic ? null : job} readingReviewSourceJobId={job} basicView={Boolean(state.basic)} onItemsChange={update} />
    </div>
    <p hidden={mode === "dimensions"}>Existing-function mode placeholder in focus-only fixture</p>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
