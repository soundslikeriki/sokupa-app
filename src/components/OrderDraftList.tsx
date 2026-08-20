"use client";

import { useMemo, useState } from "react";
import {
  Check,
  ClipboardList,
  Copy,
  ListPlus,
  Merge,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  buildOrderDraftText,
  calculateOrderDraftTotals,
  formatOrderDraftQuantity,
  manualOrderDraftInput,
} from "@/lib/order-draft";
import type { OrderDraftItem, OrderDraftItemInput, OrderDraftSourceType } from "@/types";

export type PendingOrderDraftDuplicate = {
  existingId: string;
  incoming: OrderDraftItem;
};

type OrderDraftListProps = {
  items: OrderDraftItem[];
  siteName: string;
  pendingDuplicate: PendingOrderDraftDuplicate | null;
  onUpdate: (
    id: string,
    patch: Partial<Pick<OrderDraftItem, "productCode" | "quantity" | "unit">>,
  ) => void;
  onSiteNameChange: (siteName: string) => void;
  onDelete: (id: string) => void;
  onManualAdd: (input: OrderDraftItemInput) => void;
  onMergeDuplicate: () => void;
  onKeepDuplicateSeparate: () => void;
  onCancelDuplicate: () => void;
};

const UNIT_OPTIONS = ["m", "本", "巻", "枚", "箱"];

const SOURCE_STYLES: Record<OrderDraftSourceType, string> = {
  dimension: "border-indigo-500/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  area: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  manual: "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

export function OrderDraftList({
  items,
  siteName,
  pendingDuplicate,
  onUpdate,
  onSiteNameChange,
  onDelete,
  onManualAdd,
  onMergeDuplicate,
  onKeepDuplicateSeparate,
  onCancelDuplicate,
}: OrderDraftListProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualProductCode, setManualProductCode] = useState("");
  const [manualQuantity, setManualQuantity] = useState("");
  const [manualUnit, setManualUnit] = useState("m");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const totals = useMemo(() => calculateOrderDraftTotals(items), [items]);
  const copyText = useMemo(() => buildOrderDraftText(items, siteName), [items, siteName]);
  const duplicateExisting = pendingDuplicate
    ? items.find((item) => item.id === pendingDuplicate.existingId)
    : undefined;
  const duplicateCanMerge = Boolean(
    duplicateExisting &&
      pendingDuplicate &&
      duplicateExisting.unit === pendingDuplicate.incoming.unit,
  );

  const submitManual = () => {
    const quantity = Number(manualQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    onManualAdd(
      manualOrderDraftInput({
        productCode: manualProductCode,
        quantity,
        unit: manualUnit,
      }),
    );
    setManualProductCode("");
    setManualQuantity("");
    setManualUnit("m");
    setManualOpen(false);
  };

  const copyDraft = async () => {
    if (items.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildOrderDraftText(items, siteName));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card className="border-none bg-white/75 shadow-xl ring-1 ring-inset ring-violet-500/20 backdrop-blur-xl dark:bg-zinc-900/75">
        <CardHeader className="border-b border-black/5 px-3 py-4 dark:border-white/5 sm:px-6 sm:py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-lg font-bold sm:text-xl">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white shadow-sm">
                <ClipboardList className="h-5 w-5" />
              </span>
              発注リスト
            </CardTitle>
            <Badge variant="secondary" className="px-3 py-1 text-sm font-bold">
              {items.length}項目
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-3 py-4 sm:px-6 sm:py-5">
          <div>
            <label htmlFor="order-draft-site-name" className="mb-1.5 block text-sm font-bold">
              現場名（任意）
            </label>
            <Input
              id="order-draft-site-name"
              value={siteName}
              onChange={(event) => onSiteNameChange(event.target.value)}
              className="h-11 bg-white dark:bg-black"
              placeholder="例: 渋谷区〇〇マンション"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {totals.length > 0 ? (
              totals.map((total) => (
                <div
                  key={total.unit}
                  className="rounded-lg border border-violet-500/15 bg-violet-500/[0.07] px-3 py-2"
                >
                  <span className="text-xs text-muted-foreground">合計 </span>
                  <strong className="text-lg tabular-nums text-violet-700 dark:text-violet-300">
                    {formatOrderDraftQuantity(total.quantity)}{total.unit}
                  </strong>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">計算結果または手動入力から材料を追加してください。</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full gap-2 bg-white font-bold dark:bg-black sm:w-auto"
            onClick={() => setManualOpen((current) => !current)}
            aria-expanded={manualOpen}
          >
            {manualOpen ? <X className="h-4 w-4" /> : <ListPlus className="h-4 w-4" />}
            {manualOpen ? "手動追加を閉じる" : "材料を手動追加"}
          </Button>
        </CardContent>
      </Card>

      {pendingDuplicate && duplicateExisting ? (
        <Card className="border-amber-500/30 bg-amber-500/[0.08] shadow-md">
          <CardContent className="space-y-4 px-3 py-4 sm:px-5">
            <div>
              <p className="font-bold text-amber-950 dark:text-amber-100">
                {pendingDuplicate.incoming.productCode} はすでに発注リストにあります
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
                <div className="rounded-md bg-white/70 p-2 dark:bg-black/20">
                  <dt className="text-muted-foreground">既存</dt>
                  <dd className="mt-1 font-bold tabular-nums">{formatOrderDraftQuantity(duplicateExisting.quantity)}{duplicateExisting.unit}</dd>
                </div>
                <div className="rounded-md bg-white/70 p-2 dark:bg-black/20">
                  <dt className="text-muted-foreground">今回</dt>
                  <dd className="mt-1 font-bold tabular-nums">{formatOrderDraftQuantity(pendingDuplicate.incoming.quantity)}{pendingDuplicate.incoming.unit}</dd>
                </div>
                <div className="rounded-md bg-white/70 p-2 dark:bg-black/20">
                  <dt className="text-muted-foreground">合計</dt>
                  <dd className="mt-1 font-bold tabular-nums">
                    {duplicateCanMerge
                      ? `${formatOrderDraftQuantity(duplicateExisting.quantity + pendingDuplicate.incoming.quantity)}${duplicateExisting.unit}`
                      : "単位違い"}
                  </dd>
                </div>
              </dl>
              {!duplicateCanMerge ? (
                <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">
                  単位が異なるため合算できません。別項目で追加できます。
                </p>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button type="button" className="min-h-11 gap-2" onClick={onMergeDuplicate} disabled={!duplicateCanMerge}>
                <Merge className="h-4 w-4" />
                合算する
              </Button>
              <Button type="button" variant="outline" className="min-h-11 bg-white dark:bg-black" onClick={onKeepDuplicateSeparate}>
                別項目で追加
              </Button>
              <Button type="button" variant="ghost" className="min-h-11" onClick={onCancelDuplicate}>
                キャンセル
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {manualOpen ? (
        <Card className="border-dashed border-violet-500/30 bg-violet-500/[0.04]">
          <CardContent className="space-y-3 px-3 py-4 sm:px-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="manual-order-code" className="mb-1 block text-xs font-bold">品番（任意）</label>
                <Input id="manual-order-code" value={manualProductCode} onChange={(event) => setManualProductCode(event.target.value)} className="h-11 bg-white uppercase dark:bg-black" placeholder="例: TH34486" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
                <div>
                  <label htmlFor="manual-order-quantity" className="mb-1 block text-xs font-bold">数量</label>
                  <Input id="manual-order-quantity" type="number" min="0" step="0.01" inputMode="decimal" value={manualQuantity} onChange={(event) => setManualQuantity(event.target.value)} className="h-11 bg-white font-bold tabular-nums dark:bg-black" />
                </div>
                <div>
                  <label htmlFor="manual-order-unit" className="mb-1 block text-xs font-bold">単位</label>
                  <select id="manual-order-unit" value={manualUnit} onChange={(event) => setManualUnit(event.target.value)} className="h-11 w-full rounded-md border border-input bg-white px-2 text-sm font-bold dark:bg-black">
                    {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <Button type="button" className="min-h-11 w-full gap-2 sm:w-auto" disabled={!Number.isFinite(Number(manualQuantity)) || Number(manualQuantity) <= 0} onClick={submitManual}>
              <Plus className="h-4 w-4" />
              発注リストに追加
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-violet-500/20 bg-violet-500/[0.05]">
        <CardHeader className="px-3 pb-2 pt-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-bold">現場名・日時を含めてコピーされます</CardTitle>
            <Button type="button" className="min-h-11 gap-2 bg-violet-600 font-bold hover:bg-violet-700" disabled={items.length === 0} onClick={() => void copyDraft()}>
              {copyState === "copied" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copyState === "copied" ? "コピーしました" : "発注リストをコピー"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-4 sm:px-5">
          <pre className="whitespace-pre-wrap rounded-lg border border-black/5 bg-white/80 p-3 text-xs leading-relaxed dark:border-white/5 dark:bg-black/30 sm:text-sm">{copyText}</pre>
          {copyState === "error" ? <p className="mt-2 text-xs font-semibold text-destructive">コピーできませんでした。ブラウザの権限をご確認ください。</p> : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {items.map((item) => (
          <Card key={item.id} className="overflow-hidden border-black/5 bg-white/75 shadow-sm dark:border-white/5 dark:bg-zinc-900/75">
            <CardContent className="space-y-3 px-3 py-3 sm:px-4">
              <div className="flex items-center gap-2">
                <Input
                  value={item.productCode}
                  onChange={(event) => onUpdate(item.id, { productCode: event.target.value })}
                  className="h-11 min-w-0 flex-1 bg-white text-base font-extrabold uppercase tabular-nums dark:bg-black"
                  placeholder="品番未入力"
                  aria-label={`${item.sourceLabel}の品番`}
                />
                <Badge variant="outline" className={`shrink-0 text-[10px] ${SOURCE_STYLES[item.sourceType]}`}>
                  {item.sourceLabel}
                </Badge>
                <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(item.id)} aria-label={`${item.productCode || "品番未入力"}を削除`}>
                  <Trash2 className="h-5 w-5" />
                </Button>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-muted-foreground">数量</label>
                  <Input type="number" min="0" step="0.01" inputMode="decimal" value={item.quantity} onChange={(event) => onUpdate(item.id, { quantity: Number(event.target.value) })} className="h-11 bg-white text-lg font-bold tabular-nums dark:bg-black" aria-label={`${item.productCode || "品番未入力"}の数量`} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-muted-foreground">単位</label>
                  <select value={item.unit} onChange={(event) => onUpdate(item.id, { unit: event.target.value })} className="h-11 w-full rounded-md border border-input bg-white px-2 text-sm font-bold dark:bg-black" aria-label={`${item.productCode || "品番未入力"}の単位`}>
                    {Array.from(new Set([...UNIT_OPTIONS, item.unit])).map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
