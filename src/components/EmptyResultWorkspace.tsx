"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

/** Keep original-photo recovery reachable when the result itself is hidden. */
export function EmptyResultWorkspace({ tools }: { tools: ReactNode }) {
  const id = useId(), [view, setView] = useState<"quantity" | "photo">("quantity");
  const [keyboard, setKeyboard] = useState(false);
  const select = (next: typeof view) => {
    if (next === view) return;
    const state = window.history.state ?? {};
    if (state.sokupaEmptyResult?.id !== id) window.history.replaceState({ ...state, sokupaEmptyResult: { id, view } }, "");
    window.history.pushState({ ...(window.history.state ?? {}), sokupaEmptyResult: { id, view: next } }, ""); setView(next);
  };
  useEffect(() => {
    const back = (event: PopStateEvent) => setView(event.state?.sokupaEmptyResult?.id === id && event.state.sokupaEmptyResult.view === "photo" ? "photo" : "quantity");
    const resize = () => setKeyboard(Boolean(window.visualViewport && innerHeight - window.visualViewport.height > 150));
    window.addEventListener("popstate", back); window.visualViewport?.addEventListener("resize", resize);
    return () => { window.removeEventListener("popstate", back); window.visualViewport?.removeEventListener("resize", resize); };
  }, [id]);
  return <div className="space-y-3 pb-[calc(5rem+env(safe-area-inset-bottom))]" onKeyDown={event => { if (event.key === "Escape") select("quantity"); }}>
    <section role="tabpanel" aria-label="数量" hidden={view !== "quantity"} className="space-y-3 rounded-xl border p-3">
      <p className="text-sm">表示中の結果はありません。新しい写真を選ぶか、元写真タブから前回の1件を戻せます。</p>
      <button type="button" className="min-h-11 text-sm underline" onClick={() => select("photo")}>元写真・前回の結果を開く</button>
    </section>
    <section role="tabpanel" aria-label="元写真" hidden={view !== "photo"} className="space-y-3">
      <h2 className="text-xl font-bold">元写真</h2>{tools}
    </section>
    <div role="tablist" aria-label="解析結果の表示" hidden={keyboard} className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-5xl grid-cols-3 gap-1 border-t bg-background px-2 pt-2" style={{ display: keyboard ? "none" : undefined, paddingBottom: "calc(.5rem + env(safe-area-inset-bottom))" }}>
      <button type="button" role="tab" className="min-h-14 rounded-lg text-xs font-bold" aria-selected={view === "quantity"} onClick={() => select("quantity")}>数量</button>
      <button type="button" role="tab" className="min-h-14 rounded-lg text-xs" disabled aria-selected={false}>編集・リピート</button>
      <button type="button" role="tab" className="min-h-14 rounded-lg text-xs font-bold" aria-selected={view === "photo"} onClick={() => select("photo")}>元写真</button>
    </div>
  </div>;
}
