"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Existing friend-add destination; opening this guidance never changes account settings. */
export function LineNotificationEntry() {
  const [open, setOpen] = useState(false), id = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div ref={root} data-workspace-navigation className="relative shrink-0" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" aria-label="LINE通知・友だち追加" aria-expanded={open} aria-controls={id}
      className="flex h-14 w-14 items-center justify-center rounded-lg bg-white focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={() => setOpen(value => !value)}>
      {/* Official unmodified brand PNG; 40px minimum size and surrounding clear space. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/line-app-android.png" alt="" aria-hidden="true" width={1001} height={1000} className="h-10 w-auto" />
    </button>
    {open ? <section id={id} aria-label="LINE通知の案内" className="fixed inset-x-4 top-24 z-50 space-y-3 rounded-xl border bg-background p-4 text-sm shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
      <h2 className="font-semibold">LINE通知</h2>
      <p>ソクパにログインしたLINEで友だち追加し、ブロックしていないことを確認してください。友だち追加だけでは通知の到達を保証できません。</p>
      <a href="https://lin.ee/Xr6sd53" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border px-3 font-semibold text-[#06C755]">友だち追加を開く（別画面）</a>
      <button type="button" className="block min-h-11 underline" onClick={() => { setOpen(false); trigger.current?.focus(); }}>閉じる</button>
    </section> : null}
  </div>;
}
