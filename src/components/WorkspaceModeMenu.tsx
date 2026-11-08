"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";

export type CalculationMode = "dimensions" | "area" | "order-draft";
const modes: { value: CalculationMode; label: string; detail: string }[] = [
  { value: "dimensions", label: "メモ計測", detail: "画像の寸法から計算" },
  { value: "area", label: "実寸計測", detail: "既存の㎡から必要mを計算" },
  { value: "order-draft", label: "発注リスト", detail: "追加した発注下書き" },
];

export function WorkspaceModeMenu({ value, count, onChange, help }: { value: CalculationMode; count: number; help?: ReactNode; onChange: (mode: CalculationMode) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const buttons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-mode-choice]") ?? [])];
  return <div ref={root} data-workspace-navigation className="relative shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const choices = buttons(), index = choices.indexOf(document.activeElement as HTMLButtonElement);
      choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length]?.focus();
    }
  }}>
    <button ref={trigger} type="button" aria-label="計測・発注メニュー" aria-expanded={open} aria-controls={id} className="flex min-h-11 items-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold" onClick={() => setOpen(current => !current)}>
      <Menu className="h-5 w-5" /><span className="sr-only">{modes.find(mode => mode.value === value)?.label}</span>
    </button>
    {open ? <div id={id} role="group" aria-label="既存機能へ切り替え" className="absolute right-0 z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-xl border bg-background p-2 shadow-xl">
      {modes.map(mode => <button key={mode.value} data-mode-choice type="button" aria-current={value === mode.value ? "page" : undefined} className="block min-h-14 w-full rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={() => { onChange(mode.value); setOpen(false); trigger.current?.focus(); }}>
        <span className="block font-semibold">{mode.label}{mode.value === "order-draft" && count ? ` (${count})` : ""}{value === mode.value ? " ✓" : ""}</span>
        <span className="block text-xs text-muted-foreground">{mode.detail}</span>
      </button>)}
      {help ? <details className="border-t px-3 py-2 text-sm"><summary data-workspace-navigation className="min-h-11 cursor-pointer content-center font-semibold">使い方</summary><div className="pb-2 text-xs text-muted-foreground">{help}</div></details> : null}
    </div> : null}
  </div>;
}
