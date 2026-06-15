"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyIcon, CheckCircle2, AlertTriangle, Layers, Edit3, Undo2, Globe, Plus, Trash2, Minus } from "lucide-react";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import { buildOrderRequestText } from "@/lib/order-text";
import { dedupeSlashDelimited } from "@/lib/dedupeSlashList";
import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import type { MemoProductItem } from "@/types";

const MFG_ORDER = ["サンゲツ", "リリカラ", "ルノン", "トキワ", "シンコール", "東リ", "エービーシー商会", "不明", "その他"] as const;
const DEFAULT_WALLPAPER_WIDTH_M = 0.92;

function groupLabel(manufacturer: string): (typeof MFG_ORDER)[number] {
  const m = manufacturer.trim();
  const u = m.toUpperCase();
  if (m.includes("東リ") || u.includes("TOLI")) return "東リ";
  if (m.includes("不明")) return "不明";
  for (const label of ["サンゲツ", "リリカラ", "ルノン", "トキワ", "シンコール", "エービーシー商会"] as const) {
    if (m.includes(label)) return label;
  }
  return "その他";
}

function groupByManufacturer(items: any[]) {
  const map = new Map<string, any[]>();
  for (const label of MFG_ORDER) {
    map.set(label, []);
  }
  for (const item of items) {
    const key = groupLabel(item.manufacturer);
    map.get(key)?.push(item);
  }
  return MFG_ORDER.map((label) => ({
    label,
    rows: map.get(label) ?? [],
  })).filter((g) => g.rows.length > 0);
}

type OrderListProps = {
  items: MemoProductItem[];
  notes?: string;
  siteName?: string;
  needs_review_any?: boolean;
  onItemsChange?: (items: MemoProductItem[]) => void;
};

type ItemOverride = {
  repeatCm?: number | "";
  heightM?: number | "";
  entryQtys?: Record<number, number | "">;
  entryLengths?: Record<number, number | "">;
  entryEditMode?: Record<number, boolean>;
  entryRepeatActive?: Record<number, boolean>;
};

type NewEntryInput = {
  length: string;
  quantity: string;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseWallpaperWidthM(spec: unknown): number {
  const text = String(spec ?? "").replace(/,/g, ".").trim();
  const match =
    /(?:巾|幅)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*cm/i.exec(text) ||
    /(\d+(?:\.\d+)?)\s*cm\s*(?:巾|幅)/i.exec(text);
  const widthCm = match ? Number(match[1]) : NaN;
  if (Number.isFinite(widthCm) && widthCm > 0) return widthCm / 100;
  return DEFAULT_WALLPAPER_WIDTH_M;
}

function formatSummaryNumber(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString("ja-JP", {
    maximumFractionDigits,
  });
}

function calculateLossRateFromOrderQuantity(orderQuantity: number, totalM: number): number {
  if (!Number.isFinite(orderQuantity) || !Number.isFinite(totalM) || totalM <= 0) return 0;
  return Math.max(0, Math.round(((orderQuantity / totalM) - 1) * 100));
}

function cloneMemoProductItem(item: MemoProductItem): MemoProductItem {
  return {
    ...item,
    entries: (item.entries ?? []).map((entry) => ({ ...entry })),
    repeat_info: item.repeat_info ? { ...item.repeat_info } : undefined,
    tags: item.tags ? [...item.tags] : undefined,
  };
}

export function OrderList({ items, notes, siteName = "", needs_review_any, onItemsChange }: OrderListProps) {
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});
  const [editingCode, setEditingCode] = useState<Record<string, { open: boolean; value: string }>>({});
  const [lossRates, setLossRates] = useState<Record<string, number | "">>({});
  const [newEntryInputs, setNewEntryInputs] = useState<Record<string, NewEntryInput>>({});
  const [manualOrderQuantities, setManualOrderQuantities] = useState<Record<string, number>>({});
  const newEntryInputsRef = useRef<Record<string, NewEntryInput>>({});
  const lastSyncedItemsRef = useRef("");
  const originalItemsRef = useRef<MemoProductItem[]>([]);
  const previousHadItemsRef = useRef(false);

  const getLossRateForItem = (item: MemoProductItem): number => {
    const local = lossRates[item.product_code];
    if (typeof local === "number" && Number.isFinite(local) && local >= 0) return local;
    if (typeof item.loss_rate_percent === "number" && Number.isFinite(item.loss_rate_percent) && item.loss_rate_percent >= 0) {
      return item.loss_rate_percent;
    }
    return DEFAULT_LOSS_RATE_PERCENT;
  };

  const recalcItem = (item: MemoProductItem, lossRatePercent = getLossRateForItem(item)): MemoProductItem => {
    const entries = (item.entries ?? []).map((entry) => {
      const length_m = toFiniteNumber(entry.length_m);
      const quantity = toFiniteNumber(entry.quantity);
      return {
        ...entry,
        length_m,
        quantity,
        subtotal_m: Number((length_m * quantity).toFixed(2)),
      };
    });
    const total_m = Number(entries.reduce((sum, entry) => sum + entry.subtotal_m, 0).toFixed(2));

    return {
      ...item,
      entries,
      total_m,
      order_quantity: Math.ceil(total_m * (1 + lossRatePercent / 100)),
      loss_rate_percent: lossRatePercent,
    };
  };

  const canonicalizeDerivedItem = (item: any): MemoProductItem => ({
    ...item,
    entries: (item.derivedEntries ?? item.entries ?? []).map((entry: any) => {
      const length_m = toFiniteNumber(entry.derived_length ?? entry.length_m);
      const quantity = toFiniteNumber(entry.derived_quantity ?? entry.quantity);
      return {
        original_formula: `${length_m} x ${quantity}`,
        length_m,
        quantity,
        subtotal_m: toFiniteNumber(entry.derived_subtotal ?? entry.subtotal_m, Number((length_m * quantity).toFixed(2))),
      };
    }),
  });

  const beginEditCode = (code: string) => {
    setEditingCode((prev) => ({
      ...prev,
      [code]: { open: true, value: code },
    }));
  };

  const clearManualOrderQuantity = (productCode: string) => {
    setManualOrderQuantities((prev) => {
      if (!(productCode in prev)) return prev;
      const next = { ...prev };
      delete next[productCode];
      return next;
    });
  };

  useEffect(() => {
    if (items.length === 0) {
      if (previousHadItemsRef.current) {
        originalItemsRef.current = [];
        previousHadItemsRef.current = false;
        lastSyncedItemsRef.current = "";
        setOverrides({});
        setEditingCode({});
        setLossRates({});
        setNewEntryInputs({});
        setManualOrderQuantities({});
        newEntryInputsRef.current = {};
      }
      return;
    }

    if (!previousHadItemsRef.current) {
      originalItemsRef.current = items.map(cloneMemoProductItem);
      previousHadItemsRef.current = true;
    }
  }, [items]);

  const saveCodeEdit = async (fromCode: string) => {
    const next = editingCode[fromCode];
    const toCode = (next?.value ?? "").trim().toUpperCase().replace(/[\s\-]+/g, "");
    setEditingCode((prev) => ({ ...prev, [fromCode]: { open: false, value: toCode || fromCode } }));
    if (!toCode || toCode === fromCode) return;
    if (!onItemsChange) return;

    const before = items.find((i) => i.product_code === fromCode);
    const updatedItems = items.map((i) =>
      i.product_code === fromCode ? { ...i, product_code: toCode } : i,
    );
    onItemsChange(updatedItems);

    // DBへ補正ログを保存（失敗してもUIは優先）
    try {
      await fetch("/api/memo-corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: siteName?.trim() || undefined,
          kind: "product_code",
          before: before ? { product_code: before.product_code, total_m: before.total_m, order_quantity: before.order_quantity } : { product_code: fromCode },
          after: { product_code: toCode },
        }),
      });
    } catch {
      // ignore
    }
  };

  const handleOverrideChange = (productCode: string, field: keyof Omit<ItemOverride, "entryQtys" | "entryEditMode" | "entryRepeatActive" | "entryLengths">, value: string) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const val = value === "" ? "" : Number(value);
      return {
        ...prev,
        [productCode]: {
          ...(prev[productCode] || {}),
          [field]: val
        }
      };
    });
  };

  const handleEntryFieldChange = (productCode: string, entryIndex: number, field: "entryQtys" | "entryLengths", value: string) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const val = value === "" ? "" : Number(value);
      const prevOvr = prev[productCode] || {};
      const prevFieldVals = prevOvr[field] || {};
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          [field]: {
            ...prevFieldVals,
            [entryIndex]: val
          }
        }
      };
    });
  };

  const handleLossRateChange = (productCode: string, value: string) => {
    clearManualOrderQuantity(productCode);
    const parsed = Number(value);
    const nextLoss = value === "" ? "" : Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
    setLossRates((prev) => ({
      ...prev,
      [productCode]: nextLoss,
    }));
  };

  const handleAdjustLossRate = (productCode: string, currentLossRate: number, delta: number) => {
    clearManualOrderQuantity(productCode);
    setLossRates((prev) => ({
      ...prev,
      [productCode]: Math.max(0, Math.round(currentLossRate + delta)),
    }));
  };

  const handleNewEntryChange = (productCode: string, field: keyof NewEntryInput, value: string) => {
    const prevDraft = newEntryInputsRef.current[productCode] ?? { length: "", quantity: "" };
    const nextDraft = { ...prevDraft, [field]: value };
    newEntryInputsRef.current = {
      ...newEntryInputsRef.current,
      [productCode]: nextDraft,
    };
    setNewEntryInputs((prev) => ({
      ...prev,
      [productCode]: nextDraft,
    }));
  };

  const handleAddEntry = (productCode: string) => {
    if (!onItemsChange) return;

    const draft = newEntryInputsRef.current[productCode] ?? newEntryInputs[productCode] ?? { length: "", quantity: "" };
    const length = Number(String(draft.length).trim());
    const quantity = Number(String(draft.quantity).trim());
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
    clearManualOrderQuantity(productCode);

    const sourceItems = derivedItems.length > 0 ? derivedItems.map(canonicalizeDerivedItem) : items;
    const updatedItems = sourceItems.map((item) => {
      if (item.product_code !== productCode) return item;

      const nextEntry = {
        original_formula: `${length} x ${quantity}`,
        length_m: length,
        quantity,
        subtotal_m: Number((length * quantity).toFixed(2)),
      };

      return recalcItem({
        ...item,
        entries: [...(item.entries ?? []), nextEntry],
      });
    });

    newEntryInputsRef.current = {
      ...newEntryInputsRef.current,
      [productCode]: { length: "", quantity: "" },
    };
    setNewEntryInputs((prev) => ({
      ...prev,
      [productCode]: { length: "", quantity: "" },
    }));
    onItemsChange(updatedItems);
  };

  const handleDeleteEntry = (productCode: string, entryIndex: number) => {
    if (!onItemsChange) return;
    clearManualOrderQuantity(productCode);

    const sourceItems = derivedItems.length > 0 ? derivedItems.map(canonicalizeDerivedItem) : items;
    const updatedItems = sourceItems.map((item) => {
      if (item.product_code !== productCode) return item;
      return recalcItem({
        ...item,
        entries: (item.entries ?? []).filter((_, idx) => idx !== entryIndex),
      });
    });

    setOverrides((prev) => {
      const current = prev[productCode];
      if (!current) return prev;

      const shiftRecord = <T,>(record: Record<number, T> | undefined): Record<number, T> | undefined => {
        if (!record) return undefined;
        const next: Record<number, T> = {};
        Object.entries(record).forEach(([rawIndex, value]) => {
          const idx = Number(rawIndex);
          if (!Number.isInteger(idx) || idx === entryIndex) return;
          next[idx > entryIndex ? idx - 1 : idx] = value;
        });
        return next;
      };

      return {
        ...prev,
        [productCode]: {
          ...current,
          entryQtys: shiftRecord(current.entryQtys),
          entryLengths: shiftRecord(current.entryLengths),
          entryEditMode: shiftRecord(current.entryEditMode),
          entryRepeatActive: shiftRecord(current.entryRepeatActive),
        },
      };
    });

    onItemsChange(updatedItems);
  };

  const handleToggleEntryRepeat = (productCode: string, entryIndex: number) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const prevRepeats = prevOvr.entryRepeatActive || {};
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          entryRepeatActive: {
            ...prevRepeats,
            [entryIndex]: !prevRepeats[entryIndex]
          }
        }
      };
    });
  };

  const handleToggleMasterRepeat = (productCode: string, currentMasterActive: boolean, numEntries: number) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const newRepeats: Record<number, boolean> = {};
      for (let i = 0; i < numEntries; i++) {
        newRepeats[i] = !currentMasterActive;
      }
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          entryRepeatActive: newRepeats
        }
      };
    });
  };

  const handleToggleEntryEdit = (productCode: string, entryIndex: number) => {
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const prevEdits = prevOvr.entryEditMode || {};
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          entryEditMode: {
            ...prevEdits,
            [entryIndex]: !prevEdits[entryIndex]
          }
        }
      };
    });
  };

  const handleResetEntry = (productCode: string, entryIndex: number) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const newQtys = { ...prevOvr.entryQtys };
      delete newQtys[entryIndex];
      const newLengths = { ...prevOvr.entryLengths };
      delete newLengths[entryIndex];
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          entryQtys: newQtys,
          entryLengths: newLengths
        }
      };
    });
  };

  const handleResetProductToOriginal = (productCode: string) => {
    if (!onItemsChange) return;
    const original = originalItemsRef.current.find((item) => item.product_code === productCode);
    if (!original) return;

    clearManualOrderQuantity(productCode);
    setLossRates((prev) => {
      if (!(productCode in prev)) return prev;
      const next = { ...prev };
      delete next[productCode];
      return next;
    });
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[productCode];
      return next;
    });
    setNewEntryInputs((prev) => {
      if (!(productCode in prev)) return prev;
      const next = { ...prev };
      delete next[productCode];
      return next;
    });
    delete newEntryInputsRef.current[productCode];

    onItemsChange(
      items.map((item) => (item.product_code === productCode ? cloneMemoProductItem(original) : item)),
    );
  };

  const handleSetOrderQuantity = (productCode: string, value: number) => {
    const currentItem = derivedItems.find((item) => item.product_code === productCode);
    const nextQuantity = Math.max(0, Math.ceil(toFiniteNumber(value)));
    setManualOrderQuantities((prev) => ({
      ...prev,
      [productCode]: nextQuantity,
    }));
    setLossRates((prev) => ({
      ...prev,
      [productCode]: calculateLossRateFromOrderQuantity(nextQuantity, toFiniteNumber(currentItem?.total_m)),
    }));
  };

  const handleAdjustOrderQuantity = (productCode: string, delta: number) => {
    const currentItem = derivedItems.find((item) => item.product_code === productCode);
    const currentQuantity = toFiniteNumber(currentItem?.order_quantity);
    handleSetOrderQuantity(productCode, currentQuantity + delta);
  };

  const derivedItems = useMemo(() => {
    return items.map((item) => {
      const ovr = overrides[item.product_code] || {};
      const eqtys = ovr.entryQtys || {};
      const elengths = ovr.entryLengths || {};
      const eRepeats = ovr.entryRepeatActive || {};
      const lossRate = (() => {
        const local = lossRates[item.product_code];
        if (typeof local === "number" && Number.isFinite(local) && local >= 0) return local;
        if (typeof item.loss_rate_percent === "number" && Number.isFinite(item.loss_rate_percent) && item.loss_rate_percent >= 0) {
          return item.loss_rate_percent;
        }
        return DEFAULT_LOSS_RATE_PERCENT;
      })();
      
      const r = typeof ovr.repeatCm === "number" ? ovr.repeatCm : null;
      const h = typeof ovr.heightM === "number" ? ovr.heightM : null;

      let calcTotalM = 0;
      let calcTotalQty = 0;
      let override_active = false;
      let masterRepeatStatus = true;

      const derivedEntries = (item.entries || []).map((e: any, idx: number) => {
         const qInput = eqtys[idx];
         const lInput = elengths[idx];
         const actualQ = typeof qInput === "number" ? qInput : e.quantity;
         const rowRepeatActive = eRepeats[idx] === true;

         if (!rowRepeatActive) {
            masterRepeatStatus = false;
         }
         
         if ((typeof qInput === "number" && qInput !== e.quantity) || (typeof lInput === "number" && lInput !== e.length_m)) {
             override_active = true;
         }

         const baseRowLength = typeof lInput === "number" ? lInput : e.length_m;
         let stripL = baseRowLength;
         let overridenL = typeof lInput === "number";

         // Note: row height override takes precedence. If missing, we fallback to master heightM.
         let targetHeight = baseRowLength;
         if (h !== null && h > 0 && typeof lInput !== "number") {
             targetHeight = h;
         }

         if (rowRepeatActive && targetHeight > 0) {
            stripL = targetHeight;
            override_active = true;
            overridenL = true;
         }

         if (rowRepeatActive && r !== null && r > 0 && typeof stripL === "number" && stripL > 0) {
            const r_m = r / 100;
            stripL = Math.ceil(stripL / r_m) * r_m;
            override_active = true;
            overridenL = true;
         }

         const subtotal = stripL * actualQ;
         calcTotalM += subtotal;
         calcTotalQty += actualQ;

         return {
            ...e,
            derived_length: overridenL ? Number(stripL.toFixed(2)) : e.length_m,
            derived_quantity: actualQ,
            derived_subtotal: Number(subtotal.toFixed(2)),
            isEditing: ovr.entryEditMode?.[idx] === true,
            isRepeatActive: rowRepeatActive
         };
      });

      if (!item.entries || item.entries.length === 0) {
          masterRepeatStatus = false;
      }

      if (!override_active) {
         calcTotalM = item.total_m;
      }

      const calculatedOrderQuantity = Math.ceil(calcTotalM * (1 + lossRate / 100));
      const manualOrderQuantity = manualOrderQuantities[item.product_code];
      const order_quantity =
        typeof manualOrderQuantity === "number" && Number.isFinite(manualOrderQuantity)
          ? Math.max(0, Math.round(manualOrderQuantity))
          : calculatedOrderQuantity;

      return {
        ...item,
        total_m: Number(calcTotalM.toFixed(2)),
        order_quantity,
        loss_rate_percent: lossRate,
        override_active,
        rActive: masterRepeatStatus,
        total_quantity: calcTotalQty,
        derivedEntries
      };
    });
  }, [items, overrides, lossRates, manualOrderQuantities]);

  const groups = useMemo(() => groupByManufacturer(derivedItems), [derivedItems]);
  const orderSummary = useMemo(() => {
    const totalOrderQuantity = derivedItems.reduce((sum, item) => sum + toFiniteNumber(item.order_quantity), 0);
    const totalSquareMeters = derivedItems.reduce((sum, item) => {
      const orderQuantity = toFiniteNumber(item.order_quantity);
      return sum + orderQuantity * parseWallpaperWidthM(item.spec);
    }, 0);

    return {
      totalOrderQuantity,
      totalSquareMeters: Number(totalSquareMeters.toFixed(2)),
    };
  }, [derivedItems]);

  useEffect(() => {
    if (!onItemsChange || derivedItems.length === 0) return;

    const canonicalItems: MemoProductItem[] = derivedItems.map(canonicalizeDerivedItem);

    const signature = JSON.stringify(
      canonicalItems.map((item) => ({
        product_code: item.product_code,
        total_m: item.total_m,
        order_quantity: item.order_quantity,
        loss_rate_percent: item.loss_rate_percent,
        entries: item.entries?.map((entry) => ({
          length_m: entry.length_m,
          quantity: entry.quantity,
          subtotal_m: entry.subtotal_m,
        })),
      })),
    );

    if (signature === lastSyncedItemsRef.current) return;
    lastSyncedItemsRef.current = signature;
    onItemsChange(canonicalItems);
  }, [derivedItems, onItemsChange]);

  const copyOrderText = async () => {
    if (!derivedItems.length) return;
    const text = buildOrderRequestText(derivedItems, siteName);
    try {
      await navigator.clipboard.writeText(text);
      alert("発注用テキストをコピーしました！");
    } catch {
      alert("コピーに失敗しました。");
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
      <div className="hidden print:block text-center text-black space-y-1">
        <p className="text-sm font-semibold">
          {APP_FORMAL_NAME}（{APP_PRODUCT_NAME}）— 発注・見積プレビュー
        </p>
        <p className="text-xs text-neutral-600">
          発注数量は品番ごとのロス率を加えて切り上げています。
        </p>
      </div>
      <Card className="border-none shadow-xl bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent backdrop-blur-xl ring-1 ring-inset ring-indigo-500/20">
        <CardHeader className="p-3 pb-3 sm:p-6 sm:pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <div className="shrink-0 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 p-2 shadow-lg text-white sm:p-2.5">
                <Layers className="h-4 w-4 sm:h-5 sm:w-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-xl font-bold leading-tight tracking-tight bg-gradient-to-r from-indigo-900 to-purple-900 bg-clip-text text-transparent sm:text-2xl dark:from-indigo-100 dark:to-purple-100">
                  発注リスト
                </CardTitle>
                <CardDescription className="mt-1 text-xs font-medium text-indigo-900/60 dark:text-indigo-100/60 sm:text-sm">
                  {APP_FORMAL_NAME} — AIの計測にロス率を加算、または手動でリピート計算を行います
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="rounded-lg bg-white/70 px-3 py-2 text-xs font-bold shadow-sm dark:bg-black/60 sm:text-sm">
              初期ロス {DEFAULT_LOSS_RATE_PERCENT}%
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-3 pb-4 pt-0 sm:space-y-5 sm:px-6 sm:pb-6">
          <p className="max-w-3xl text-xs leading-relaxed text-indigo-900/85 dark:text-indigo-100/85 sm:text-sm">
            発注数量は品番ごとのロス率を加えて切り上げています。
            <span className="text-[11px] text-muted-foreground sm:text-xs">（初期値 {DEFAULT_LOSS_RATE_PERCENT}%）</span>
          </p>
          {needs_review_any && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 shadow-inner sm:gap-3 sm:p-4">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                黄色のバッジがついている推測結果は必ず現場メモ・見本帳と一致しているかご確認ください。
              </p>
            </div>
          )}
          <Button 
            onClick={() => void copyOrderText()} 
            className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 py-5 text-sm font-semibold shadow-lg transition-all duration-300 hover:from-indigo-700 hover:to-purple-700 hover:shadow-xl sm:py-6 sm:text-base"
          >
            <CopyIcon className="w-4 h-4 mr-2" />
            発注用テキストをコピー
          </Button>
          {notes && (
            <div className="rounded-xl border border-black/5 bg-white/50 p-3 text-xs font-medium dark:border-white/5 dark:bg-black/20 sm:p-4 sm:text-sm">
              <span className="opacity-70">メモ備考:</span> {notes}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-none bg-gradient-to-r from-indigo-600/10 via-purple-600/10 to-indigo-600/5 shadow-lg ring-1 ring-inset ring-indigo-500/20 backdrop-blur-xl">
        <CardContent className="grid gap-3 px-3 py-4 sm:grid-cols-2 sm:px-6 sm:py-5">
          <div className="rounded-xl border border-indigo-500/10 bg-white/70 p-4 shadow-sm dark:bg-black/30">
            <p className="text-xs font-bold text-indigo-900/60 dark:text-indigo-100/60">合計発注数量</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-black tabular-nums tracking-tight text-indigo-700 dark:text-indigo-300 sm:text-4xl">
                {formatSummaryNumber(orderSummary.totalOrderQuantity, 0)}
              </span>
              <span className="text-base font-bold text-indigo-900/60 dark:text-indigo-100/60">m</span>
            </div>
          </div>
          <div className="rounded-xl border border-purple-500/10 bg-white/70 p-4 shadow-sm dark:bg-black/30">
            <p className="text-xs font-bold text-purple-900/60 dark:text-purple-100/60">合計平米数</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-black tabular-nums tracking-tight text-purple-700 dark:text-purple-300 sm:text-4xl">
                {formatSummaryNumber(orderSummary.totalSquareMeters)}
              </span>
              <span className="text-base font-bold text-purple-900/60 dark:text-purple-100/60">㎡</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4 sm:space-y-6">
        {groups.map((group) => (
          <Card key={group.label} className="border-none shadow-md overflow-hidden bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md">
            <CardHeader className="flex flex-row items-center justify-between border-b border-black/5 bg-black/5 px-3 py-3 dark:border-white/5 dark:bg-white/5 sm:px-6 sm:py-4">
              <CardTitle className="text-base font-bold tracking-tight sm:text-lg">{group.label}</CardTitle>
              <Badge variant="secondary" className="px-3 py-1 font-bold rounded-full bg-white dark:bg-black text-xs shadow-sm">
                {group.rows.length} 品番
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {group.rows.map((product, idx) => (
                <div key={product.product_code} className={`px-3 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 ${idx !== 0 ? "border-t border-black/5 dark:border-white/5" : ""} transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]`}>
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
                      <div className="min-w-0">
                        {editingCode[product.product_code]?.open ? (
                          <Input
                            value={editingCode[product.product_code]?.value ?? product.product_code}
                            onChange={(e) =>
                              setEditingCode((prev) => ({
                                ...prev,
                                [product.product_code]: { open: true, value: e.target.value },
                              }))
                            }
                            onBlur={() => void saveCodeEdit(product.product_code)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void saveCodeEdit(product.product_code);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingCode((prev) => ({
                                  ...prev,
                                  [product.product_code]: { open: false, value: product.product_code },
                                }));
                              }
                            }}
                            className="h-9 w-[10.5rem] px-2 text-base font-extrabold tabular-nums sm:h-10 sm:w-[12rem] sm:text-xl"
                            aria-label="品番を編集"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditCode(product.product_code)}
                            className="min-w-0 text-left text-lg font-extrabold tracking-tight underline-offset-4 hover:underline sm:text-xl"
                            title="タップして品番を編集"
                          >
                            {product.product_code}
                          </button>
                        )}
                      </div>
                      {product.tags && product.tags.length > 0 && (
                        <div className="flex gap-1 ml-1">
                          {product.tags.map((tag: string) => (
                            <Badge key={tag} variant="secondary" className="bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-1.5 py-0 text-[10px]">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {product.is_live_searched ? (
                        <Badge variant="outline" className="text-cyan-600 border-cyan-600/30 bg-cyan-500/10 gap-1 px-2 py-0.5 ml-1">
                          <Globe className="w-3.5 h-3.5" />
                          <span className="text-xs">ネット引用</span>
                        </Badge>
                      ) : product.needs_review ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-600/30 bg-amber-500/10 gap-1 px-2 py-0.5 ml-1">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span className="text-xs">要確認</span>
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-600/30 bg-emerald-500/10 gap-1 px-2 py-0.5 ml-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span className="text-xs">確証済</span>
                        </Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:self-auto">
                      <div className="flex items-center gap-2 rounded-xl border border-black/5 bg-black/5 p-1.5 dark:bg-white/5">
                        <span className="pl-2 text-[10px] font-medium opacity-60 sm:text-xs">ロス率</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustLossRate(product.product_code, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, -1)}
                          disabled={(product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT) <= 0}
                          aria-label={`${product.product_code} のロス率を1%減らす`}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          className="h-11 w-16 bg-white px-2 text-center text-base font-bold tabular-nums dark:bg-black"
                          value={lossRates[product.product_code] ?? product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}
                          onChange={(e) => handleLossRateChange(product.product_code, e.target.value)}
                          aria-label={`${product.product_code} のロス率を入力`}
                        />
                        <span className="text-xs font-semibold opacity-60">%</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustLossRate(product.product_code, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, 1)}
                          aria-label={`${product.product_code} のロス率を1%増やす`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 rounded-xl border border-black/5 bg-black/5 p-1.5 dark:bg-white/5">
                        <span className="pl-2 text-[10px] font-medium opacity-60 sm:text-xs">発注数量</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustOrderQuantity(product.product_code, -1)}
                          disabled={product.order_quantity <= 0}
                          aria-label={`${product.product_code} の発注数量を1m減らす`}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <div className="flex min-w-[6.5rem] items-center justify-center gap-1 rounded-lg bg-white px-2 py-1.5 dark:bg-black">
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            className="h-9 w-16 border-none bg-transparent p-0 text-center text-xl font-black tabular-nums leading-none text-indigo-600 shadow-none focus-visible:ring-0 dark:text-indigo-400 sm:text-2xl"
                            value={product.order_quantity}
                            onChange={(e) => handleSetOrderQuantity(product.product_code, Number(e.target.value))}
                            aria-label={`${product.product_code} の発注数量を入力`}
                          />
                          <span className="text-sm font-semibold opacity-60">m</span>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustOrderQuantity(product.product_code, 1)}
                          aria-label={`${product.product_code} の発注数量を1m増やす`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mb-6 grid grid-cols-1 gap-2.5 md:grid-cols-2 md:gap-3">
                    <div className="rounded-xl border border-black/5 bg-white/60 p-2.5 dark:border-white/5 dark:bg-black/40 sm:p-3">
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider opacity-50 sm:text-[10px]">規格・寸法</span>
                      <span className="text-xs font-medium leading-snug sm:text-sm">
                        {dedupeSlashDelimited(product.spec?.trim() || "") || "情報なし"}
                      </span>
                    </div>
                    <div className="rounded-xl border border-black/5 bg-white/60 p-2.5 dark:border-white/5 dark:bg-black/40 sm:p-3">
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider opacity-50 sm:text-[10px]">リピート</span>
                      <span className="text-xs font-medium leading-snug sm:text-sm">{product.repeat_info?.from_product?.trim() || "情報なし"}</span>
                    </div>
                    {product.notes?.trim() && (
                      <div className="rounded-xl border border-black/5 bg-white/60 p-2.5 text-xs font-medium text-muted-foreground dark:border-white/5 dark:bg-black/40 sm:p-3 sm:text-sm md:col-span-2">
                        <span className="mr-2 opacity-60">備考:</span>
                        {dedupeSlashDelimited(product.notes.trim())}
                      </div>
                    )}
                  </div>

                  <div className="mb-6 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 rounded-lg border-black/10 bg-white/70 px-3 text-xs font-semibold text-muted-foreground hover:bg-white hover:text-indigo-700 dark:border-white/10 dark:bg-black/30 dark:hover:bg-black"
                      onClick={() => handleResetProductToOriginal(product.product_code)}
                    >
                      ↺ 解析結果に戻す
                    </Button>
                  </div>

                  <div className="mb-6 mt-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3 shadow-sm transition-colors dark:border-indigo-900/30 dark:bg-indigo-900/10 sm:p-4">
                    <div className="text-xs font-bold uppercase tracking-wider text-indigo-800/60 dark:text-indigo-300/60 mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-indigo-900 dark:text-indigo-100 font-semibold text-[11px]">
                        <Layers className="w-3.5 h-3.5" />
                        リピート・高さで一括計算
                      </div>
                      <div className="flex items-center gap-2">
                        {product.rActive && product.override_active && (
                           <Badge variant="default" className="text-[10px] px-2 py-0 bg-indigo-600 hover:bg-indigo-700 shadow border-none">適用中</Badge>
                        )}
                        <button 
                          onClick={() => handleToggleMasterRepeat(product.product_code, product.rActive, product.derivedEntries?.length || 0)}
                          className={`w-[34px] h-[20px] flex items-center rounded-full p-[2px] transition-colors ${product.rActive ? 'bg-indigo-600' : 'bg-black/20 dark:bg-white/20'}`}
                        >
                          <div className={`bg-white w-4 h-4 rounded-full shadow-sm transform transition-transform ${product.rActive ? 'translate-x-[14px]' : ''}`} />
                        </button>
                      </div>
                    </div>
                    
                    <div className={`flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4 transition-opacity duration-300 ${(product.derivedEntries || []).some((e: any) => e.isRepeatActive) ? 'opacity-100' : 'opacity-40'}`}>
                      <div className="flex-1">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">壁の高さ (m)</label>
                        <Input 
                          type="number" 
                          step="0.1" 
                          placeholder="例: 2.4" 
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          value={overrides[product.product_code]?.heightM ?? ""}
                          onChange={(e) => handleOverrideChange(product.product_code, "heightM", e.target.value)}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">リピート (cm)</label>
                        <Input 
                          type="number" 
                          step="0.1" 
                          placeholder="例: 32" 
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          value={overrides[product.product_code]?.repeatCm ?? ""}
                          onChange={(e) => handleOverrideChange(product.product_code, "repeatCm", e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {((product.source_url && product.source_url.trim() !== "null") || product.confidence != null || product.catalog_name) && (
                    <div className="flex flex-wrap items-center gap-4 mb-6 px-1">
                      {product.catalog_name && (
                         <div className="text-xs flex items-center font-semibold px-2 py-1 rounded bg-gradient-to-r from-purple-500/10 to-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20">
                           <Layers className="w-3.5 h-3.5 mr-1" />
                           {product.catalog_name}{product.catalog_page_num ? ` (P.${product.catalog_page_num})` : ""}
                         </div>
                      )}
                      {product.source_url && product.source_url.trim() !== "null" && (() => {
                        try {
                          const urlObj = new URL(product.source_url);
                          return (
                            <div className="text-xs text-indigo-600 dark:text-indigo-400 font-medium flex items-center hover:underline cursor-pointer">
                              <a href={product.source_url} target="_blank" rel="noopener noreferrer" className="flex items-center">
                                <span className="mr-1 opacity-70">情報元:</span>
                                <span className="truncate max-w-[150px]">{urlObj.hostname}</span>
                              </a>
                            </div>
                          );
                        } catch {
                          return null;
                        }
                      })()}
                      {product.confidence != null && (
                        <div className="text-xs font-semibold px-2 py-0.5 rounded border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5">
                          推測確度: {Math.round(product.confidence * 100)}%
                        </div>
                      )}
                    </div>
                  )}

                  <div className="group/memo relative overflow-hidden rounded-xl bg-black/5 p-2.5 dark:bg-white/5 sm:p-4">
                    <div className="mb-4 flex flex-wrap items-center">
                      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider opacity-60 sm:text-xs">
                        計測メモ
                      </span>
                    </div>
                    <div className="space-y-3">
                       {product.derivedEntries?.map((e: any, eidx: number) => {
                         const rawQty = overrides[product.product_code]?.entryQtys?.[eidx];
                         const rawLen = overrides[product.product_code]?.entryLengths?.[eidx];
                         const qValue = rawQty !== undefined ? rawQty : e.quantity;
                         const lValue = rawLen !== undefined ? rawLen : e.length_m;
                         
                         return (
                           <div
                             key={eidx}
                             className="group/row flex flex-col gap-1.5 rounded-lg border border-black/5 bg-white/50 px-1.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-white/80 dark:border-white/5 dark:bg-black/50 dark:hover:bg-black/80 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-2 sm:text-sm"
                           >
                              <div className="flex w-full min-w-0 items-center justify-between gap-1 sm:gap-2">
                                <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
                                  <button 
                                    type="button"
                                    onClick={() => handleToggleEntryRepeat(product.product_code, eidx)}
                                    className="-ml-1 flex shrink-0 items-center justify-center p-1.5 sm:m-0 sm:p-0"
                                    title="この行にリピート計算を適用する"
                                    aria-pressed={e.isRepeatActive}
                                  >
                                    <span className={`flex h-3.5 w-6 items-center rounded-full p-px transition-colors ${e.isRepeatActive ? 'bg-indigo-600' : 'bg-black/20 dark:bg-white/20'}`}>
                                      <span className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${e.isRepeatActive ? 'translate-x-[10px]' : ''}`} />
                                    </span>
                                  </button>

                                  <div 
                                    className="flex w-full min-w-0"
                                    onBlur={(ev) => {
                                      if (!ev.currentTarget.contains(ev.relatedTarget)) {
                                        setOverrides((prev) => {
                                          const po = prev[product.product_code];
                                          if (!po || !po.entryEditMode || !po.entryEditMode[eidx]) return prev;
                                          return { ...prev, [product.product_code]: { ...po, entryEditMode: { ...po.entryEditMode, [eidx]: false } } };
                                        });
                                      }
                                    }}
                                  >
                                    {e.isEditing ? (
                                      <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
                                        <Input 
                                          autoFocus
                                          type="number" 
                                          step="0.1" 
                                          className="h-8 w-[4.25rem] border-indigo-300 px-1 text-center text-xs font-bold tabular-nums shadow-inner focus-visible:ring-indigo-500 dark:border-indigo-700 sm:w-[5.5rem] sm:text-sm"
                                          value={lValue}
                                          onChange={(input) => handleEntryFieldChange(product.product_code, eidx, "entryLengths", input.target.value)}
                                        />
                                        <span className="shrink-0 text-[11px] sm:text-sm">m</span>
                                        <span className="mx-0.5 shrink-0 text-[11px] text-muted-foreground sm:text-sm">×</span>
                                        <Input 
                                          type="number" 
                                          className="h-8 w-[3.25rem] border-indigo-300 px-1 text-center text-xs font-bold tabular-nums shadow-inner focus-visible:ring-indigo-500 dark:border-indigo-700 sm:w-[4rem] sm:text-sm"
                                          value={qValue}
                                          onChange={(input) => handleEntryFieldChange(product.product_code, eidx, "entryQtys", input.target.value)}
                                        />
                                        <button
                                          type="button"
                                          onClick={() => handleResetEntry(product.product_code, eidx)}
                                          className="ml-0.5 shrink-0 rounded-md p-1.5 text-rose-500/80 transition-colors hover:bg-black/10 hover:text-rose-500 dark:hover:bg-white/10"
                                          title="この行の編集を元に戻す"
                                        >
                                          <Undo2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button 
                                        type="button"
                                        onClick={() => handleToggleEntryEdit(product.product_code, eidx)}
                                        className="group/formula flex min-w-0 flex-1 items-center gap-0.5 rounded-md px-0.5 py-0.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5 sm:max-w-[12rem] sm:gap-1.5 sm:px-1 sm:py-1"
                                        title="タップして式を編集"
                                      >
                                        <span className={`min-w-0 shrink-0 truncate tabular-nums ${typeof rawLen === "number" && rawLen !== e.length_m ? "font-bold text-indigo-600 dark:text-indigo-400" : ""}`}>
                                          {e.derived_length}m
                                        </span>
                                        <span className="shrink-0 text-muted-foreground mx-px">×</span>
                                        <span className={`min-w-[1.25rem] shrink-0 text-center font-bold tabular-nums sm:w-[2.5rem] ${typeof rawQty === "number" && rawQty !== e.quantity ? "text-indigo-600 dark:text-indigo-400" : ""}`}>
                                          {qValue}
                                        </span>
                                        <Edit3 className="ml-1 h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover/formula:opacity-40" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                
                                <div className="flex shrink-0 items-center justify-end pl-1 sm:pl-2">
                                  <span className="w-[3.25rem] shrink-0 text-right text-xs font-bold tabular-nums leading-none text-indigo-600 dark:text-indigo-400 sm:w-16 sm:text-base">
                                    {e.derived_subtotal}m
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteEntry(product.product_code, eidx)}
                                    className="ml-1 shrink-0 rounded-md p-1.5 text-rose-500/80 transition-colors hover:bg-rose-500/10 hover:text-rose-600"
                                    title="この数式を削除"
                                    aria-label="この数式を削除"
                                  >
                                    <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                                  </button>
                                </div>
                              </div>
                           </div>
                         );
                       })}
                    </div>
                    <div className="mt-3 rounded-lg border border-dashed border-indigo-300/70 bg-white/50 p-2 dark:border-indigo-700/70 dark:bg-black/30 sm:p-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[5.5rem] flex-1">
                          <label className="mb-1 block text-[10px] font-bold opacity-60">長さ (m)</label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="2.7"
                            className="h-9 bg-white text-sm font-bold tabular-nums dark:bg-black"
                            value={newEntryInputs[product.product_code]?.length ?? ""}
                            onChange={(e) => handleNewEntryChange(product.product_code, "length", e.target.value)}
                          />
                        </div>
                        <span className="pb-2 text-sm font-bold text-muted-foreground">×</span>
                        <div className="min-w-[4.5rem] flex-1">
                          <label className="mb-1 block text-[10px] font-bold opacity-60">枚数</label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="1"
                            className="h-9 bg-white text-sm font-bold tabular-nums dark:bg-black"
                            value={newEntryInputs[product.product_code]?.quantity ?? ""}
                            onChange={(e) => handleNewEntryChange(product.product_code, "quantity", e.target.value)}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 shrink-0 gap-1.5 rounded-lg border-indigo-300 bg-white px-3 text-xs font-bold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:bg-black dark:text-indigo-200 dark:hover:bg-indigo-950"
                          onClick={() => handleAddEntry(product.product_code)}
                        >
                          <Plus className="h-4 w-4" />
                          幅数を追加
                        </Button>
                      </div>
                    </div>
                    <div className="flex justify-between items-center mt-3 pt-3 border-t border-black/10 dark:border-white/10 px-2">
                       <span className="text-xs font-bold opacity-60">ロス {product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}%</span>
                       <span className="text-xs font-bold tabular-nums">
                         <span className="opacity-60 mr-1">計測合計:</span>
                         <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{product.total_m}m</span>
                         <span className="opacity-50 mx-1">/</span>
                         <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{(product.total_m * parseWallpaperWidthM(product.spec)).toFixed(2)}㎡</span>
                       </span>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
