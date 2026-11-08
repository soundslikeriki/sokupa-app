"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { readingEvidenceGroups } from "@/lib/order-presentation";
import type { MemoReadingReview } from "@/types";

export type CopyReviewRow = { id: string; code: string; quantity: number; quantityIncomplete: boolean; token: string; ready: boolean;
  confirmable: boolean; blockedMessage: string; reviews: MemoReadingReview[]; imageIndexes: number[] };

type Props = {
  open: boolean; rows: CopyReviewRow[]; batchToken: string; copyReady: boolean; siteName: string;
  photo: ReactNode; onPhoto: (index: number) => void; onEdit: (id: string) => void; onClose: () => void;
  onApply: (selections: { id: string; token: string }[], batchToken: string) => boolean;
  onCopy: (batchToken: string) => Promise<boolean>;
};

/** One explicit per-product acknowledgement; applying and clipboard access are separate taps. */
export function CopyReviewDialog({ open, rows, batchToken, copyReady, siteName, photo, onPhoto, onEdit, onClose, onApply, onCopy }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<{ batch: string; values: Record<string, string> }>({ batch: batchToken, values: {} });
  const [initialTokens] = useState(() => Object.fromEntries(rows.map(row => [row.id, row.token])));
  const [appliedTokens, setAppliedTokens] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  if (selection.batch !== batchToken) {
    setSelection({ batch: batchToken, values: {} });
    setNotice("内容が変わりました。表示中の候補と数量を確認し直してください。");
  }
  const staleSelection = selection.batch !== batchToken;
  const selected = staleSelection ? {} : selection.values;
  const ready = (row: CopyReviewRow) => row.ready && (initialTokens[row.id] === row.token || appliedTokens[row.id] === row.token);
  const changedContent = rows.some(row => initialTokens[row.id] !== row.token && appliedTokens[row.id] !== row.token);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) { if (element.open) element.close(); return; }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!element.open) element.showModal();
    closeButton.current?.focus();
    return () => { document.body.style.overflow = overflow; };
  }, [open]);
  const pending = rows.filter(row => !ready(row) && selected[row.id] === row.token && row.confirmable);
  return <dialog ref={dialog} aria-label="発注内容を確認してコピー" aria-modal="true"
    className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none border-0 bg-background p-0 text-foreground backdrop:bg-black/40"
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}
    onKeyDown={event => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,summary,[tabindex]"))
        .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    }}>
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-3 pb-3 pt-[max(.75rem,env(safe-area-inset-top))]">
        <div><h2 className="text-lg font-bold">確認してコピー</h2><p className="text-xs text-muted-foreground">{siteName || "現場名なし"}・{rows.length}品番</p></div>
        <Button ref={closeButton} type="button" variant="outline" data-workspace-navigation onClick={onClose}>戻る</Button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3" aria-label="コピー前の確認内容">
        {notice || staleSelection || changedContent ? <p role="alert" className="rounded-lg border border-amber-500 p-2 text-sm">{notice || "内容が変わりました。表示中の候補と数量を確認し直してください。"}</p> : null}
        {photo}
        {readingEvidenceGroups(rows).length ? <section aria-label="訂正・取消の照合内容" className="space-y-3 rounded-xl border p-3 text-xs">
          <h3 className="font-bold">読み取りの確認</h3>
          {readingEvidenceGroups(rows).map(({key,review,codes}) => <div key={key} className="space-y-1 break-words">
            <p className="font-semibold">対象：{codes.join("・")}</p>
            {review.reason.length > 140 ? <details data-workspace-navigation><summary>{review.reason.slice(0,100)}…（全文）</summary><p>{review.reason}</p></details> : <p>{review.reason}</p>}
            {review.candidate_formulas.length ? <p>候補：{review.candidate_formulas.join(" ／ ")}</p> : null}
            <p>{review.source_image_index === undefined ? "写真の対応も確認してください" : `写真${review.source_image_index+1}`}</p>
          </div>)}
          <p>有効な訂正は明細へ反映し、取消なら除外を照合してください。対象品番ごとに確認します。</p>
        </section> : null}
        {rows.map(row => <section key={row.id} aria-label={`${row.code} のコピー前確認`} className="space-y-2 rounded-xl border p-3">
          <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-all font-bold">{row.code}</h3><strong className="shrink-0 text-2xl tabular-nums text-indigo-700 dark:text-indigo-300">{row.quantityIncomplete || !Number.isFinite(row.quantity) || row.quantity <= 0 ? "未確定" : `${row.quantity}m`}</strong></div>
          {row.reviews.length ? <p className="text-xs">訂正・取消：上の「読み取りの確認」の対象 {row.code} と照合</p> : null}
          {row.imageIndexes.length ? <div className="flex flex-wrap gap-2">{row.imageIndexes.map(index => <Button key={index} type="button" variant="outline" className="min-h-11 text-xs" aria-label={`${row.code} の写真${index + 1}`} data-workspace-navigation onClick={() => onPhoto(index)}>写真{index + 1}を確認</Button>)}</div> : null}
          {ready(row) ? <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">確認済み</p> : <>
            {!row.confirmable ? <p role="status" className="text-sm text-amber-800 dark:text-amber-200">{row.blockedMessage}</p> : null}
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" aria-label={`${row.code} の${row.reviews.length ? "訂正候補と数量" : "数量"}を確認した`}
                checked={selected[row.id] === row.token} disabled={!row.confirmable}
                onChange={event => setSelection(previous => ({ batch: batchToken, values: { ...(previous.batch === batchToken ? previous.values : {}), [row.id]: event.target.checked ? row.token : "" } }))} />
              {row.reviews.length ? "この品番の候補を照合し、数量を確認した" : "この品番の数量を確認した"}
            </label>
          </>}
          <Button type="button" variant="outline" className="min-h-11 text-xs" aria-label={`${row.code} を編集`} data-workspace-navigation onClick={() => onEdit(row.id)}>数量・明細を編集</Button>
        </section>)}
      </div>
      <footer className="shrink-0 space-y-2 border-t bg-background px-3 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{rows.filter(ready).length}/{rows.length}品番 確認済み</span><span>未反映のチェックは戻ると破棄します。</span></div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" className="min-h-12 px-2 text-sm" disabled={!pending.length} onClick={() => {
            if (!onApply(pending.map(row => ({ id: row.id, token: row.token })), batchToken)) setNotice("内容または入力条件が変わりました。確認し直してください。");
            else { setAppliedTokens(previous => ({ ...previous, ...Object.fromEntries(pending.map(row => [row.id, row.token])) })); setSelection({ batch: batchToken, values: {} }); setNotice(""); }
          }}>確認を反映</Button>
          <Button type="button" className="min-h-12" aria-label="発注用テキストをコピー" disabled={!copyReady || !rows.every(ready)} onClick={() => {
            // Invoke directly in this user gesture, after confirmations rendered ready.
            void onCopy(batchToken).then(ok => { if (!ok) setNotice("コピーできませんでした。内容と端末のコピー許可を確認してください。"); });
          }}>コピー</Button>
        </div>
      </footer>
    </div>
  </dialog>;
}
