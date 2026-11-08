"use client";

import { useEffect, useLayoutEffect, useId, useState, type ReactNode } from "react";
import { Layers, Edit3, ImageIcon } from "lucide-react";

/** Keep original-photo recovery reachable when the result itself is hidden. */
export function EmptyResultWorkspace({ tools, onWorkspaceViewChange }: { tools: ReactNode; onWorkspaceViewChange?: (view: "quantity" | "photo") => void }) {
  const id = useId(), [view, setView] = useState<"quantity" | "photo">("quantity");
  useLayoutEffect(() => { onWorkspaceViewChange?.(view); }, [view, onWorkspaceViewChange]);
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
    <section role="tabpanel" aria-label="概要" hidden={view !== "quantity"} className="space-y-3 rounded-xl border p-3">
      <p className="text-sm">表示中の結果はありません。新しい写真を選ぶか、メモ画像タブから前回の1件を戻せます。</p>
      <button type="button" className="min-h-11 text-sm underline" onClick={() => select("photo")}>メモ画像・前回の結果を開く</button>
    </section>
    <section role="tabpanel" aria-label="メモ画像" hidden={view !== "photo"} className="space-y-3">
      <h2 className="text-xl font-bold">メモ画像</h2>{tools}
    </section>
    <div role="tablist" aria-label="解析結果の表示" hidden={keyboard} className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-5xl grid-cols-3 gap-1 border-t bg-background px-2 pt-2" style={{ display: keyboard ? "none" : undefined, paddingBottom: "calc(.5rem + env(safe-area-inset-bottom))" }}>
      <button type="button" role="tab" className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-bold ${view === "quantity" ? "bg-indigo-950 text-white" : "text-muted-foreground"}`} aria-selected={view === "quantity"} onClick={() => select("quantity")}><Layers aria-hidden="true" focusable="false" className="h-5 w-5" />概要</button>
      <button type="button" role="tab" className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs text-muted-foreground disabled:opacity-50" disabled aria-selected={false}><Edit3 aria-hidden="true" focusable="false" className="h-5 w-5" />数量</button>
      <button type="button" role="tab" className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-bold ${view === "photo" ? "bg-indigo-950 text-white" : "text-muted-foreground"}`} aria-selected={view === "photo"} onClick={() => select("photo")}><ImageIcon aria-hidden="true" focusable="false" className="h-5 w-5" />メモ画像</button>
    </div>
  </div>;
}
