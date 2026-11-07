"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyIcon, CheckCircle2, AlertTriangle, Layers, Edit3, Undo2, Globe, Plus, Trash2, Minus, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, ListPlus, ImageIcon } from "lucide-react";
import { roundMeters } from "@/lib/memo-calculation";
import { orderModeForItem, planMemoOrder } from "@/lib/order-planning";
import { compactReadingReviews, compactReviewReasons, shortOrderStatus } from "@/lib/order-presentation";
import { findOriginalMemoEntry } from "@/lib/original-memo-entry";
import { calculateOrderQuantity, DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import {
  areAllCodesCollapsed,
  pruneCollapsedCodes,
  toggleAllCollapsedCodes,
  toggleCollapsedCode,
} from "@/lib/collapse-state";
import { buildOrderRequestText } from "@/lib/order-text";
import { dimensionItemToOrderDraftInput } from "@/lib/order-draft";
import { dedupeSlashDelimited } from "@/lib/dedupeSlashList";
import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import type { MemoProductItem, MemoReadingReview, OrderDraftItemInput } from "@/types";

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
  basicView?: boolean;
  items: MemoProductItem[];
  sourceItems?: MemoProductItem[];
  sourceJobId?: string | null;
  readingReviewSourceJobId?: string | null;
  notes?: string;
  siteName?: string;
  needs_review_any?: boolean;
  onItemsChange?: (items: MemoProductItem[]) => void;
  onAddToOrderDraft?: (item: OrderDraftItemInput) => void;
  onAddAllToOrderDraft?: (items: OrderDraftItemInput[]) => void;
};

type ItemOverride = {
  orderMode?: MemoProductItem["order_mode"];
  patternRowsConfigured?: boolean;
  memoAllowance?: MemoProductItem["memo_allowance"];
  measurementBasis?: MemoProductItem["measurement_basis"];
  patternMatch?: MemoProductItem["pattern_match"];
  quantityConfirmation?: string;
  readingReviewConfirmation?: string;
  repeatCm?: number | string;
  heightM?: number | string;
  entryQtys?: Record<number, number | string>;
  entryLengths?: Record<number, number | string>;
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

function orderCheckMessage(item: { orderReady: boolean; quantityAssessment: { message: string } }, basicView: boolean): string {
  return basicView && item.orderReady ? "確認済み：入力した発注数量を元メモ・写真と照合してください。" : item.quantityAssessment.message;
}

function orderCheckColor(ready: boolean, basicView: boolean): string {
  return ready ? basicView ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300";
}

function readingReviewImageIndexes(item: { readingReviews: MemoReadingReview[]; entries: MemoProductItem["entries"] }): number[] {
  const valid = (index: number | undefined): index is number => index !== undefined && Number.isSafeInteger(index) && index >= 0;
  const fallback = item.entries.map(entry => entry.source_image_index).filter(valid);
  return [...new Set(item.readingReviews.flatMap(review => valid(review.source_image_index) ? [review.source_image_index] : fallback))];
}

function cloneMemoProductItem(item: MemoProductItem): MemoProductItem {
  return {
    ...item,
    entries: (item.entries ?? []).map((entry) => ({ ...entry })),
    repeat_info: item.repeat_info ? { ...item.repeat_info } : undefined,
    tags: item.tags ? [...item.tags] : undefined,
    reading_reviews: item.reading_reviews?.map(review => ({ ...review, candidate_formulas: [...review.candidate_formulas] })),
  };
}

export function OrderList({ basicView = false, items, sourceItems, sourceJobId, readingReviewSourceJobId, notes, siteName = "", needs_review_any, onItemsChange, onAddToOrderDraft, onAddAllToOrderDraft }: OrderListProps) {
  const privatePhotoJobId = sourceJobId ?? readingReviewSourceJobId;
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const currentPhotoRef = useRef("");
  const [photoCount, setPhotoCount] = useState<number | null>(null);
  const [photoCountError, setPhotoCountError] = useState(false);
  const [photoRequest, setPhotoRequest] = useState(0);
  const [resultView, setResultView] = useState<"quantity" | "edit" | "photo">("quantity");
  const [selectedProductCode, setSelectedProductCode] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const resultRoot = useRef<HTMLDivElement>(null);
  const componentId = useId();
  const workspaceId = `${componentId}:${privatePhotoJobId ?? "legacy-workspace"}`;
  const navId = `result-${workspaceId}`;
  const photoKey = `${privatePhotoJobId}:${photoIndex}:${photoRequest}`;
  useLayoutEffect(() => { currentPhotoRef.current = photoKey; }, [photoKey]);
  const views = [{ value: "quantity", label: "数量" }, { value: "edit", label: "編集・リピート" }, { value: "photo", label: "元写真" }] as const;
  const selectView = (view: typeof resultView, code = selectedProductCode, record = true) => {
    if (view === resultView && code === selectedProductCode) return;
    if (record && (view !== resultView || code !== selectedProductCode)) {
      const previous = window.history.state ?? {};
      if (previous.sokupaResult?.id !== workspaceId) window.history.replaceState({ ...previous, sokupaResult: { id: workspaceId, view: resultView, code: selectedProductCode } }, "");
      window.history.pushState({ ...(window.history.state ?? {}), sokupaResult: { id: workspaceId, view, code } }, "");
    }
    setSelectedProductCode(code); setResultView(view);
    window.requestAnimationFrame(() => {
      const panel = resultRoot.current?.querySelector<HTMLElement>(`[data-result-panel="${view}"]`);
      if (panel && panel.getClientRects().length && !document.activeElement?.matches("input,select,textarea")) { panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: "start" }); }
    });
  };
  const openPhoto = (index: number) => { setPhotoError(false); setPhotoIndex(index); selectView("photo"); };
  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      const state = event.state?.sokupaResult;
      if (state?.id === workspaceId && ["quantity", "edit", "photo"].includes(state.view)) { setResultView(state.view); setSelectedProductCode(typeof state.code === "string" ? state.code : ""); }
      else setResultView("quantity");
      window.requestAnimationFrame(() => {
        const view = state?.id === workspaceId && ["quantity", "edit", "photo"].includes(state.view) ? state.view : "quantity";
        const panel = resultRoot.current?.querySelector<HTMLElement>(`[data-result-panel="${view}"]`);
        if (panel?.getClientRects().length) panel.focus({ preventScroll: true });
      });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [workspaceId]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => setKeyboardOpen(Boolean(viewport && window.innerHeight - viewport.height > 150));
    resize(); viewport?.addEventListener("resize", resize);
    return () => viewport?.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (resultView !== "photo" || !privatePhotoJobId || photoCount !== null) return;
    const abort = new AbortController(); setPhotoCountError(false);
    void fetch(`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const json = await response.json(); const count = json.data?.total_images;
      if (!response.ok || !Number.isInteger(count) || count < 1 || count > 5 || (json.data?.id && json.data.id !== privatePhotoJobId)) throw new Error("Invalid image metadata");
      if (!abort.signal.aborted) { setPhotoCount(count); setPhotoIndex(index => index ?? 0); }
    }).catch(() => { if (!abort.signal.aborted) setPhotoCountError(true); });
    return () => abort.abort();
  }, [resultView, privatePhotoJobId, photoCount, photoRequest]);
  const [rowResetError, setRowResetError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});
  const [editingCode, setEditingCode] = useState<Record<string, { open: boolean; value: string }>>({});
  const [lossRates, setLossRates] = useState<Record<string, number | string>>({});
  const [newEntryInputs, setNewEntryInputs] = useState<Record<string, NewEntryInput>>({});
  const [orderQuantityInputs, setOrderQuantityInputs] = useState<Record<string,string | undefined>>({});
  const [manualOrderQuantities, setManualOrderQuantities] = useState<Record<string, number>>({});
  const [collapsedCodes, setCollapsedCodes] = useState<Set<string>>(() => new Set());
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
      order_quantity: calculateOrderQuantity(total_m, lossRatePercent),
      loss_rate_percent: lossRatePercent,
    };
  };

  const canonicalizeDerivedItem = (item: any): MemoProductItem => {
    const { derivedEntries, override_active, rActive, total_quantity, comparison, comparisonConfirmed, quantityAssessment, incompleteMeasurements, incompleteSettings, orderReady, confirmationFingerprint, canConfirm, automaticQuantity, manualQuantityActive, allowanceIncluded, readingReviews, readingReviewFingerprint, readingReviewConfirmed, canConfirmReadingReview, ...base } = item;
    return {
      ...base,
      entries: (derivedEntries ?? item.entries ?? []).map((entry: any) => {
        const length_m = toFiniteNumber(entry.base_length ?? entry.length_m);
        const quantity = toFiniteNumber(entry.derived_quantity ?? entry.quantity);
        return {
          source_row_id: entry.source_row_id, source_image_index: entry.source_image_index, source_entry_index: entry.source_entry_index,
          original_formula: entry.original_formula || `${length_m} x ${quantity}`,
          repeat_enabled: entry.configured_repeat_enabled ?? entry.isRepeatActive ?? entry.repeat_enabled ?? false,
          needs_review: entry.needs_review, review_reason: entry.review_reason,
          length_m, quantity, length_input: entry.length_input, quantity_input: entry.quantity_input,
          subtotal_m: toFiniteNumber(entry.derived_subtotal ?? entry.subtotal_m, Number((length_m * quantity).toFixed(2))),
        };
      }),
    };
  };

  const beginEditCode = (code: string) => {
    setEditingCode((prev) => ({
      ...prev,
      [code]: { open: true, value: code },
    }));
  };

  const invalidateConfirmation = (productCode: string) => {
    setOverrides(previous => ({ ...previous, [productCode]: { ...previous[productCode], quantityConfirmation: "", readingReviewConfirmation: "" } }));
  };

  const clearManualOrderQuantity = (productCode: string) => {
    invalidateConfirmation(productCode);
    setManualOrderQuantities((prev) => {
      return { ...prev, [productCode]: NaN };
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
      originalItemsRef.current = (sourceItems ?? items).map(cloneMemoProductItem);
      previousHadItemsRef.current = true;
    }
  }, [items, sourceItems]);

  useEffect(() => {
    const productCodes = items.map((item) => item.product_code);
    setCollapsedCodes((current) => {
      const next = pruneCollapsedCodes(current, productCodes);
      if (next.size === current.size && Array.from(next).every((code) => current.has(code))) {
        return current;
      }
      return next;
    });
  }, [items]);

  const saveCodeEdit = async (fromCode: string) => {
    const next = editingCode[fromCode];
    const toCode = (next?.value ?? "").trim().toUpperCase().replace(/[\s\-]+/g, "");
    setEditingCode((prev) => ({ ...prev, [fromCode]: { open: false, value: toCode || fromCode } }));
    if (!toCode || toCode === fromCode) return;
    if (!onItemsChange) return;

    const before = items.find((i) => i.product_code === fromCode);
    const updatedItems = items.map((i) =>
      i.product_code === fromCode ? { ...i, product_code: toCode, quantity_confirmation: "", reading_review_confirmation: "" } : i,
    );
    setSelectedProductCode(toCode);
    setNewEntryInputs(previous => { const next = { ...previous, [toCode]: previous[fromCode] }; delete next[fromCode]; newEntryInputsRef.current = next; return next; });
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

  const handleOverrideChange = (productCode: string, field: "repeatCm" | "heightM", value: string) => {
    const numeric = Number(value);
    const val = /^\d{1,12}(?:\.\d{1,6})?$/.test(value) && Number.isFinite(numeric) && numeric > 0 ? numeric : value;
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
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
    const numeric = Number(value);
    const val = /^\d{1,12}(?:\.\d{1,6})?$/.test(value) && Number.isFinite(numeric) ? numeric : value;
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const prevFieldVals = prevOvr[field] || {};
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          quantityConfirmation: "", readingReviewConfirmation: "",
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
    const nextLoss = /^\d{1,12}(?:\.\d{1,6})?$/.test(value) && Number.isFinite(parsed) ? Math.round(parsed) : value;
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
      const item = items.find(item => item.product_code === productCode)!;
      const enabled = (prevOvr.orderMode ?? orderModeForItem(item)) === "pattern";
      const prevRepeats = Object.fromEntries(item.entries.map((entry, index) => [index, enabled && (prevOvr.entryRepeatActive?.[index] ?? entry.repeat_enabled ?? false)]));
      const nextRepeats = { ...prevRepeats, [entryIndex]: !prevRepeats[entryIndex] };
      return {
        ...prev,
        [productCode]: {
          ...prevOvr,
          entryRepeatActive: nextRepeats,
          orderMode: Object.values(nextRepeats).some(Boolean) ? "pattern" : "memo",
          patternRowsConfigured: true,
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
          entryRepeatActive: newRepeats,
          orderMode: currentMasterActive ? "memo" : "pattern",
          patternRowsConfigured: true,
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
    const original = findOriginalMemoEntry(
      originalItemsRef.current.find((item) => item.product_code === productCode)?.entries ?? [],
      items.find((item) => item.product_code === productCode)?.entries[entryIndex],
    );
    if (!original) {
      setRowResetError("元の行を特定できませんでした。写真や元メモを確認し、長さと幅数を入力してください。");
      return;
    }
    setRowResetError(null);
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const newQtys = { ...prevOvr.entryQtys };
      newQtys[entryIndex] = original.quantity;
      const newLengths = { ...prevOvr.entryLengths };
      newLengths[entryIndex] = original.length_m;
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
    setOrderQuantityInputs(previous => ({ ...previous, [productCode]: undefined }));

    onItemsChange(
      items.map((item) => (item.product_code === productCode ? { ...cloneMemoProductItem(original), quantity_confirmation: "", reading_review_confirmation: "" } : item)),
    );
  };

  const handleSetOrderQuantity = (productCode: string, value: number) => {
    invalidateConfirmation(productCode);
    setOrderQuantityInputs(previous => ({ ...previous, [productCode]: undefined }));
    const nextQuantity = Math.max(0, Math.ceil(toFiniteNumber(value)));
    setManualOrderQuantities((prev) => ({
      ...prev,
      [productCode]: nextQuantity,
    }));

  };

  const handleOrderQuantityInput = (code: string, raw: string) => {
    invalidateConfirmation(code);
    if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) > 999999999999) {
      setOrderQuantityInputs(previous => ({ ...previous, [code]: raw }));
      return;
    }
    handleSetOrderQuantity(code, Number(raw));
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
      
      const r = typeof ovr.repeatCm === "number" ? ovr.repeatCm : ovr.repeatCm === "" ? null : item.repeat_cm ?? null;
      const h = typeof ovr.heightM === "number" ? ovr.heightM : ovr.heightM === "" ? null : item.repeat_height_m ?? null;
      const mode = ovr.orderMode ?? orderModeForItem(item);
      const memoAllowance = ovr.memoAllowance ?? item.memo_allowance ?? "add";
      const rawSetting = (local: number | string | undefined, saved: string | undefined) => typeof local === "string" ? local || undefined : typeof local === "number" ? undefined : saved;
      const lossInput = typeof lossRates[item.product_code] === "string" ? lossRates[item.product_code] as string : typeof lossRates[item.product_code] === "number" ? undefined : item.loss_rate_input;
      const planningItem = { ...item, order_mode: mode, memo_allowance: memoAllowance, loss_rate_input: lossInput,
        pattern_rows_configured: ovr.patternRowsConfigured ?? item.pattern_rows_configured ?? mode === "pattern",
        repeat_cm_input: rawSetting(ovr.repeatCm, item.repeat_cm_input), repeat_height_input: rawSetting(ovr.heightM, item.repeat_height_input) };

      let calcTotalM = 0;
      let calcTotalQty = 0;
      let override_active = false;
      let masterRepeatStatus = true;

      const basis = ovr.measurementBasis ?? item.measurement_basis ?? "unconfirmed";
      const match = ovr.patternMatch ?? item.pattern_match ?? "unconfirmed";
      const rows = (item.entries || []).map((e: any, idx: number) => {
        const base = typeof elengths[idx] === "number" ? elengths[idx] as number : e.length_m;
        const active = mode === "pattern" && (eRepeats[idx] ?? e.repeat_enabled ?? false);
        // A common height is an explicit override. Otherwise preserve every row's own height.
        return { id: e.source_row_id ?? `${item.product_code}:${idx}`, length: active && h !== null && h > 0 && typeof elengths[idx] !== "number" ? h : base,
          quantity: typeof eqtys[idx] === "number" ? eqtys[idx] as number : e.quantity, active,
          lengthInput: typeof elengths[idx] === "string" ? elengths[idx] as string : typeof elengths[idx] === "number" ? undefined : e.length_input,
          quantityInput: typeof eqtys[idx] === "string" ? eqtys[idx] as string : typeof eqtys[idx] === "number" ? undefined : e.quantity_input };
      });
      const manualOrderQuantity = Object.prototype.hasOwnProperty.call(manualOrderQuantities, item.product_code) ? manualOrderQuantities[item.product_code] : item.manual_order_quantity;
      const confirmation = ovr.quantityConfirmation ?? item.quantity_confirmation;
      const readingReviewConfirmation = ovr.readingReviewConfirmation ?? item.reading_review_confirmation;
      const rawOrder = Object.prototype.hasOwnProperty.call(orderQuantityInputs, item.product_code) ? orderQuantityInputs[item.product_code] : item.order_quantity_input;
      const plan = planMemoOrder({ item: planningItem, rows, repeatCm: r, basis, match, lossRate, manualQuantity: manualOrderQuantity, rawOrder, confirmation, readingReviewConfirmation, globalNotes: notes });
      const { comparison } = plan;
      const derivedEntries = (item.entries || []).map((e: any, idx: number) => {
        const row = rows[idx], base = typeof elengths[idx] === "number" ? elengths[idx] as number : e.length_m;
        if (!row.active) masterRepeatStatus = false;
        const exact = comparison.strict.rows[idx]?.selected.perStripM ?? comparison.reference?.rows[idx]?.selected.perStripM;
        const stripL = exact === null || exact === undefined ? base : Number(exact);
        if (row.active || base !== e.length_m || row.quantity !== e.quantity) override_active = true;
        const subtotal = stripL * row.quantity;
        calcTotalM = roundMeters(calcTotalM + roundMeters(subtotal)); calcTotalQty += row.quantity;
        return { ...e, base_length: base, derived_length: Number(stripL.toFixed(6)), derived_quantity: row.quantity,
          length_input: row.lengthInput, quantity_input: row.quantityInput,
          configured_repeat_enabled: eRepeats[idx] ?? e.repeat_enabled ?? false,
          derived_subtotal: Number(subtotal.toFixed(6)), isEditing: ovr.entryEditMode?.[idx] === true, isRepeatActive: row.active };
      });

      if (!item.entries || item.entries.length === 0) {
          masterRepeatStatus = false;
      }



      return {
        ...planningItem,
        measurement_basis: basis, pattern_match: match, quantity_confirmation: confirmation, order_quantity_input: rawOrder,
        reading_reviews: plan.readingReviews.length || item.reading_reviews ? plan.readingReviews : undefined, reading_review_confirmation: readingReviewConfirmation,
        readingReviews: plan.readingReviews, readingReviewFingerprint: plan.readingReviewFingerprint, readingReviewConfirmed: plan.readingReviewConfirmed, canConfirmReadingReview: plan.canConfirmReadingReview,
        comparison, comparisonConfirmed: plan.confirmed, quantityAssessment: plan.assessment,
        incompleteMeasurements: plan.incompleteMeasurements, incompleteSettings: plan.incompleteSettings,
        orderReady: plan.ready, canConfirm: plan.canConfirm, confirmationFingerprint: plan.fingerprint,
        automaticQuantity: plan.automaticQuantity, manualQuantityActive: plan.manual, allowanceIncluded: plan.allowanceIncluded,
        total_m: Number(calcTotalM.toFixed(2)),
        order_quantity: plan.orderQuantity,
        loss_rate_percent: lossRate,
        repeat_cm: r ?? undefined,
        repeat_height_m: h ?? undefined,
        manual_order_quantity: Number.isFinite(manualOrderQuantity) ? manualOrderQuantity : undefined,
        override_active,
        rActive: masterRepeatStatus,
        total_quantity: calcTotalQty,
        derivedEntries
      };
    });
  }, [items, notes, overrides, lossRates, manualOrderQuantities, orderQuantityInputs]);

  const groups = useMemo(() => groupByManufacturer(derivedItems), [derivedItems]);
  const reviewReasonGroups = useMemo(() => compactReviewReasons(derivedItems), [derivedItems]);
  const productCodes = useMemo(() => derivedItems.map((item) => item.product_code), [derivedItems]);
  const activeProductCode = productCodes.includes(selectedProductCode) ? selectedProductCode : productCodes[0];
  const allCodesCollapsed = useMemo(
    () => areAllCodesCollapsed(collapsedCodes, productCodes),
    [collapsedCodes, productCodes],
  );
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
        reading_reviews: item.reading_reviews, reading_review_confirmation: item.reading_review_confirmation,
        order_mode: item.order_mode, pattern_rows_configured: item.pattern_rows_configured, memo_allowance: item.memo_allowance, loss_rate_input: item.loss_rate_input, repeat_cm_input: item.repeat_cm_input, repeat_height_input: item.repeat_height_input,
        total_m: item.total_m,
        order_quantity: item.order_quantity,
        loss_rate_percent: item.loss_rate_percent,
        repeat_cm: item.repeat_cm, repeat_height_m: item.repeat_height_m, manual_order_quantity: item.manual_order_quantity,
        measurement_basis: item.measurement_basis, pattern_match: item.pattern_match, quantity_confirmation: item.quantity_confirmation, order_quantity_input: item.order_quantity_input,
        entries: item.entries?.map((entry) => ({
          length_m: entry.length_m,
          quantity: entry.quantity,
          subtotal_m: entry.subtotal_m, repeat_enabled: entry.repeat_enabled, length_input: entry.length_input, quantity_input: entry.quantity_input,
        })),
      })),
    );

    if (signature === lastSyncedItemsRef.current) return;
    lastSyncedItemsRef.current = signature;
    onItemsChange(canonicalItems);
  }, [derivedItems, onItemsChange]);

  const copyOrderText = async () => {
    if (!derivedItems.length || derivedItems.some(item => !item.orderReady)) return;
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
    <div ref={resultRoot} className="space-y-3 pb-[calc(5rem+env(safe-area-inset-bottom))] print:pb-0" onKeyDown={event => {
      if (event.key === "Escape" && resultView !== "quantity" && !(event.target as HTMLElement).closest("input,select,textarea")) { event.preventDefault(); selectView("quantity"); }
    }}>
      <section id={`${navId}-quantity`} data-result-panel="quantity" role="tabpanel" aria-labelledby={`${navId}-quantity-tab`} tabIndex={-1} hidden={resultView !== "quantity"} className="scroll-mt-4 space-y-3 outline-none print:block">
      <div className="hidden print:block text-center text-black space-y-1">
        <p className="text-sm font-semibold">
          {APP_FORMAL_NAME}（{APP_PRODUCT_NAME}）— 発注・見積プレビュー
        </p>
        <p className="text-xs text-neutral-600">
          自動計算は予備分を加えて1m単位に切り上げます。調整済み・手動指定の発注量には再上乗せしません。
        </p>
      </div>
      <Card className="border-none bg-white/70 shadow-md dark:bg-zinc-900/70">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 p-3">
          <CardTitle className="text-xl font-bold">発注数量</CardTitle>
          <Badge variant="secondary">予備 {DEFAULT_LOSS_RATE_PERCENT}%</Badge>
          <Button aria-label="発注用テキストをコピー" aria-describedby={`${navId}-copy-status`} onClick={() => void copyOrderText()} disabled={derivedItems.some(item => !item.orderReady)} className="min-h-11 gap-2">
            <CopyIcon className="h-4 w-4" />コピー
          </Button>
        </CardHeader>
        <CardContent id={`${navId}-copy-status`} className="px-3 pb-3 pt-0 text-xs text-muted-foreground">{derivedItems.some(item => !item.orderReady) ? "要確認の数量は参考値です。" : "確認済みの数量をコピーできます。"}</CardContent>
      </Card>

      <Card className="border-none bg-white/70 shadow-lg ring-1 ring-inset ring-indigo-500/15 backdrop-blur-xl dark:bg-zinc-900/70">
        <CardHeader className="px-3 pb-2 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-indigo-900 dark:text-indigo-100 sm:text-base">
            <CopyIcon className="h-4 w-4" />
            発注内容の確認
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 px-3 pb-4 pt-0 sm:px-6 sm:pb-5">
          {derivedItems.map((item) => {
            const code = String(item.product_code ?? "").trim() || "不明";
            const quantity = toFiniteNumber(item.order_quantity);
            return (
              <div
                key={code}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-black/5 bg-black/[0.03] px-2 py-1.5 dark:border-white/5 dark:bg-white/[0.04] sm:px-3"
              >
                <p className="min-w-0 flex-1 break-words text-sm font-bold text-zinc-900 dark:text-zinc-100">{code}</p>
                <p className="shrink-0 text-xl font-extrabold tabular-nums" aria-label={`${code} の一覧発注数量`}>{item.incompleteMeasurements || item.incompleteSettings || item.order_quantity_input !== undefined || quantity <= 0 ? "未確定" : `${quantity}m`}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 rounded-md bg-white p-0 dark:bg-black"
                    onClick={() => handleAdjustOrderQuantity(item.product_code, -1)}
                    disabled={quantity <= 0 || (item.order_quantity_input !== undefined || item.incompleteMeasurements)}
                    aria-label={`${code} の発注数量を1m減らす`}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 rounded-md bg-white p-0 dark:bg-black"
                    disabled={(item.order_quantity_input !== undefined || item.incompleteMeasurements)}
                    onClick={() => handleAdjustOrderQuantity(item.product_code, 1)}
                    aria-label={`${code} の発注数量を1m増やす`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex w-full items-center justify-between gap-2">
                  <p className={`text-xs ${orderCheckColor(item.orderReady, basicView)}`} role="status" aria-label={`${code} の発注量チェック`}>{shortOrderStatus(item)}{item.orderReady || item.incompleteMeasurements || item.incompleteSettings || item.order_quantity_input !== undefined ? "" : "・参考値"}</p>
                  <button type="button" className="min-h-11 text-xs underline" aria-label={`${code} を確認・編集`} data-workspace-navigation onClick={() => { setCollapsedCodes(current => { const next = new Set(current); next.delete(code); return next; }); selectView("edit", code); }}>確認・編集</button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <p className="px-2 text-xs text-muted-foreground">合計 {formatSummaryNumber(orderSummary.totalOrderQuantity, 0)}m ／ {formatSummaryNumber(orderSummary.totalSquareMeters)}㎡{derivedItems.some(item => !item.orderReady) ? "（確認前の参考値を含む）" : ""}</p>
      {onAddAllToOrderDraft && derivedItems.length > 1 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            className="min-h-11 w-full gap-2 bg-violet-600 px-4 font-bold hover:bg-violet-700 sm:w-auto"
            disabled={derivedItems.some(item => !item.orderReady)}
            onClick={() => derivedItems.every(item => item.orderReady) &&
              onAddAllToOrderDraft(
                derivedItems.map((item) => dimensionItemToOrderDraftInput(item)),
              )
            }
          >
            <ListPlus className="h-4 w-4" />
            すべて発注リストへ追加（{derivedItems.length}品番）
          </Button>
        </div>
      ) : null}

      </section>
      <section id={`${navId}-photo`} data-result-panel="photo" role="tabpanel" aria-labelledby={`${navId}-photo-tab`} tabIndex={-1} hidden={resultView !== "photo"} className="scroll-mt-4 space-y-3 outline-none print:hidden">
        <div className="flex items-center justify-between gap-2"><h2 className="text-xl font-bold">元写真</h2><Button type="button" variant="outline" data-workspace-navigation onClick={() => selectView("edit", activeProductCode)}>編集に戻る</Button></div>
        {!privatePhotoJobId ? <p role="status">この結果には元写真の参照がありません。お手元の写真と照合してください。</p> : photoCountError ? <div role="alert"><p>元写真の一覧を取得できませんでした。結果と編集は保持しています。</p><Button type="button" variant="outline" onClick={() => { setPhotoCountError(false); setPhotoRequest(value => value + 1); }}>写真一覧を再取得</Button></div> : photoCount === null ? <p role="status">元写真を確認中…</p> : <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="元写真を選択">{Array.from({ length: photoCount }, (_, index) => <Button key={index} type="button" variant={photoIndex === index ? "default" : "outline"} aria-pressed={photoIndex === index} data-workspace-navigation onClick={() => openPhoto(index)}>写真 {index + 1}</Button>)}</div>
          {photoIndex !== null && (photoIndex < 0 || photoIndex >= photoCount) ? <p role="alert">指定された元写真が見つかりません。上の写真番号から選び直してください。</p> : photoError ? <div role="alert"><p>写真を取得できませんでした。通信とログイン状態を確認してください。</p><Button type="button" variant="outline" onClick={() => { setPhotoError(false); setPhotoRequest(value => value + 1); }}>写真を再取得</Button></div> : <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={photoKey} className="max-h-[70dvh] w-full rounded-lg object-contain" alt={`解析元の写真 ${(photoIndex ?? 0) + 1}`} src={`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}/images/${photoIndex ?? 0}`} onError={() => { if (currentPhotoRef.current === photoKey) setPhotoError(true); }} />
            <a className="inline-block min-h-11 content-center text-sm underline" href={`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}/images/${photoIndex ?? 0}`} target="_blank" rel="noopener noreferrer">写真を別画面で拡大</a>
          </>}
        </>}
      </section>
      <section id={`${navId}-edit`} data-result-panel="edit" role="tabpanel" aria-labelledby={`${navId}-edit-tab`} tabIndex={-1} hidden={resultView !== "edit"} className="scroll-mt-4 space-y-3 outline-none print:block">
        <div className="flex items-center justify-between gap-2"><h2 className="text-xl font-bold">編集・リピート</h2><Button type="button" variant="outline" data-workspace-navigation onClick={() => selectView("quantity")}>数量に戻る</Button></div>
        <label className="block text-sm font-semibold">編集する品番<select aria-label="編集する品番" data-workspace-navigation className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" value={activeProductCode} onChange={event => setSelectedProductCode(event.target.value)}>{groups.map(group => <optgroup key={group.label} label={group.label}>{group.rows.map(product => <option key={product.product_code} value={product.product_code}>{product.product_code}</option>)}</optgroup>)}</select></label>
      <details className="rounded-xl border bg-background p-3 text-sm" aria-label="読み取り・計算の説明">
        <summary className="min-h-6 cursor-pointer font-medium">説明・注意を表示{needs_review_any || reviewReasonGroups.length ? "（読み取り確認あり）" : ""}</summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>自動計算は予備分を加えて1m単位に切り上げます。調整済み・手動指定の発注量には再上乗せしません。</p>
          {reviewReasonGroups.length ? <ul className="space-y-2 break-words text-amber-800 dark:text-amber-200">{reviewReasonGroups.map(({reason,codes}) => <li key={reason}><span className="font-semibold">{codes.join("・")}</span> — {reason}</li>)}</ul> : null}
          {notes && !reviewReasonGroups.some(row => row.reason.includes(notes.trim())) ? <p>メモ備考：{notes}</p> : null}
        </div>
      </details>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-black/5 bg-white/60 px-3 py-2.5 shadow-sm dark:border-white/5 dark:bg-zinc-900/60 sm:px-4">
        <div className="min-w-0">
          <p className="text-sm font-bold">材料詳細</p>
          <p className="text-[11px] text-muted-foreground sm:text-xs">
            {collapsedCodes.size}/{productCodes.length} 品番を省略中
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 gap-2 rounded-lg bg-white px-3 text-xs font-bold dark:bg-black sm:text-sm"
          onClick={() => setCollapsedCodes((current) => toggleAllCollapsedCodes(current, productCodes))}
          aria-label={allCodesCollapsed ? "すべての材料詳細を展開" : "すべての材料詳細を省略"}
        >
          {allCodesCollapsed ? <ChevronsDown className="h-4 w-4" /> : <ChevronsUp className="h-4 w-4" />}
          {allCodesCollapsed ? "すべて展開" : "すべて省略"}
        </Button>
      </div>

      {rowResetError ? <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{rowResetError}</p> : null}
      <div className="space-y-4 sm:space-y-6">
        {groups.map((group) => (
          <Card key={group.label} hidden={!group.rows.some(product => product.product_code === activeProductCode)} className="border-none shadow-md overflow-hidden bg-white/60 print:block dark:bg-zinc-900/60 backdrop-blur-md">
            <CardHeader className="flex flex-row items-center justify-between border-b border-black/5 bg-black/5 px-3 py-3 dark:border-white/5 dark:bg-white/5 sm:px-6 sm:py-4">
              <CardTitle className="text-base font-bold tracking-tight sm:text-lg">{group.label}</CardTitle>
              <Badge variant="secondary" className="px-3 py-1 font-bold rounded-full bg-white dark:bg-black text-xs shadow-sm">
                {group.rows.length} 品番
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {group.rows.map((product, idx) => {
                const isCollapsed = collapsedCodes.has(product.product_code);
                return (
                <div hidden={product.product_code !== activeProductCode} id={`material-${encodeURIComponent(product.product_code)}`} key={product.product_code} className={`print:block px-3 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 ${idx !== 0 ? "border-t border-black/5 dark:border-white/5" : ""} transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]`}>
                  {isCollapsed ? (
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-extrabold tracking-tight sm:text-lg">{product.product_code}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-semibold tabular-nums text-muted-foreground sm:text-xs">
                          <span>計測 <strong className="text-foreground">{product.total_m}m</strong></span>
                          <span aria-hidden>／</span>
                          <span>予備分 <strong className="text-foreground">{product.allowanceIncluded ? "調整済み（追加なし）" : `${product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}%`}</strong></span>
                          <span aria-hidden>／</span>
                          <span>{product.orderReady ? "発注" : "参考"} <strong className="text-lg text-indigo-600 dark:text-indigo-400">{product.order_quantity}m</strong></span>
                        </div>
                        {product.readingReviews.length && !product.readingReviewConfirmed ? <p className="mt-2 text-xs font-semibold text-amber-800 dark:text-amber-300">訂正・取消の確認が必要です。詳細を開いて原画像と照合してください。</p> : null}
                      </div>
                      {onAddToOrderDraft ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-11 shrink-0 gap-1.5 rounded-lg bg-white px-2.5 text-xs font-bold dark:bg-black"
                          disabled={!product.orderReady}
                          onClick={() => product.orderReady && onAddToOrderDraft(dimensionItemToOrderDraftInput(product))}
                          title="発注リストに追加"
                        >
                          <ListPlus className="h-4 w-4" />
                          追加
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                        onClick={() => setCollapsedCodes((current) => toggleCollapsedCode(current, product.product_code))}
                        aria-expanded={false}
                        aria-label={`${product.product_code} の詳細を展開`}
                      >
                        <ChevronDown className="h-5 w-5" />
                      </Button>
                    </div>
                  ) : (
                    <>
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
                            onBlur={event => { if (!(event.relatedTarget as HTMLElement | null)?.closest("[data-workspace-navigation]")) void saveCodeEdit(product.product_code); }}
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
                            className="min-w-0 break-all text-left text-lg font-extrabold tracking-tight underline-offset-4 hover:underline sm:text-xl"
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
                      {product.is_live_searched && !product.needs_review ? (
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
                        <Badge variant="outline" className={`gap-1 px-2 py-0.5 ml-1 ${!basicView && product.orderReady ? "text-emerald-600 border-emerald-600/30 bg-emerald-500/10" : "text-amber-600 border-amber-600/30 bg-amber-500/10"}`}>
                          {!basicView && product.orderReady ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                          <span className="text-xs">{basicView ? "数量を確認" : product.orderReady ? "発注内容確認済" : "数量を確認"}</span>
                        </Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
                      {onAddToOrderDraft ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-11 gap-2 rounded-lg bg-white px-3 text-xs font-bold dark:bg-black sm:text-sm"
                          disabled={!product.orderReady}
                          onClick={() => product.orderReady && onAddToOrderDraft(dimensionItemToOrderDraftInput(product))}
                        >
                          <ListPlus className="h-4 w-4" />
                          発注リストに追加
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-11 w-11 shrink-0 rounded-lg bg-white p-0 dark:bg-black"
                        onClick={() => setCollapsedCodes((current) => toggleCollapsedCode(current, product.product_code))}
                        aria-expanded={true}
                        aria-label={`${product.product_code} の詳細を省略`}
                      >
                        <ChevronUp className="h-5 w-5" />
                      </Button>
                    </div>
                    <div className="grid w-full gap-2 self-start sm:w-[25rem] sm:self-auto">
                      <div className="grid w-full grid-cols-[4.5rem_2.75rem_minmax(4.25rem,1fr)_1.5rem_2.75rem] items-center gap-2 rounded-xl border border-black/5 bg-black/5 p-1.5 dark:bg-white/5 sm:grid-cols-[5rem_2.75rem_minmax(5rem,1fr)_1.75rem_2.75rem]">
                        <span className="pl-2 text-[10px] font-medium opacity-60 sm:text-xs">予備分</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustLossRate(product.product_code, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, -1)}
                          disabled={product.allowanceIncluded || (product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT) <= 0}
                          aria-label={`${product.product_code} のロス率を1%減らす`}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          className="h-11 w-full bg-white px-2 text-center text-base font-bold tabular-nums dark:bg-black"
                          value={lossRates[product.product_code] ?? product.loss_rate_input ?? product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}
                          disabled={product.allowanceIncluded}
                          onChange={(e) => handleLossRateChange(product.product_code, e.target.value)}
                          aria-label={`${product.product_code} のロス率を入力`}
                        />
                        <span className="text-center text-sm font-semibold opacity-60">%</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          disabled={product.allowanceIncluded}
                          onClick={() => handleAdjustLossRate(product.product_code, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, 1)}
                          aria-label={`${product.product_code} のロス率を1%増やす`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid w-full grid-cols-[4.5rem_2.75rem_minmax(4.25rem,1fr)_1.5rem_2.75rem] items-center gap-2 rounded-xl border border-black/5 bg-black/5 p-1.5 dark:bg-white/5 sm:grid-cols-[5rem_2.75rem_minmax(5rem,1fr)_1.75rem_2.75rem]">
                        <span className="pl-2 text-[10px] font-medium opacity-60 sm:text-xs">発注数量</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          onClick={() => handleAdjustOrderQuantity(product.product_code, -1)}
                          disabled={product.order_quantity <= 0 || (product.order_quantity_input !== undefined || product.incompleteMeasurements)}
                          aria-label={`${product.product_code} の発注数量を1m減らす`}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          className="h-11 w-full bg-white px-2 text-center text-xl font-black tabular-nums leading-none text-indigo-600 dark:bg-black dark:text-indigo-400 sm:text-2xl"
                          value={product.order_quantity_input ?? product.order_quantity}
                          onChange={(e) => handleOrderQuantityInput(product.product_code, e.target.value)}
                          aria-label={`${product.product_code} の発注数量を入力`}
                        />
                        <span className="text-center text-sm font-semibold opacity-60">m</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          disabled={(product.order_quantity_input !== undefined || product.incompleteMeasurements)}
                          onClick={() => handleAdjustOrderQuantity(product.product_code, 1)}
                          aria-label={`${product.product_code} の発注数量を1m増やす`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-black/5 bg-black/5 px-3 py-2 dark:bg-white/5">
                        <span className="text-[10px] font-medium opacity-60 sm:text-xs">計測合計</span>
                        <span className="text-xs font-bold tabular-nums sm:text-sm">
                          <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{product.total_m}m</span>
                          <span className="opacity-50 mx-1">/</span>
                          <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{(product.total_m * parseWallpaperWidthM(product.spec)).toFixed(2)}㎡</span>
                        </span>
                      </div>
                    </div>
                  {product.readingReviews.length ? <section aria-label={`${product.product_code} の訂正・取消の確認`} className="mb-3 w-full space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
                    <p className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4 shrink-0" />訂正・取消を確認</p>
                    <details aria-label={`${product.product_code} の読み取り詳細`}>
                      <summary className="min-h-8 cursor-pointer text-xs font-medium">読み取りの詳細を表示</summary>
                      <div className="mt-2 space-y-2 break-words text-xs">{compactReadingReviews(product.readingReviews).map((review, index) => <div key={index}>
                        <p>{review.reason}</p>
                        {review.candidate_formulas.length ? <ul className="list-inside list-disc font-semibold">{review.candidate_formulas.map(formula => <li key={formula}>{formula}</li>)}</ul> : <p>訂正箇所を原画像で確認してください。</p>}
                      </div>)}</div>
                      <p className="mt-2 text-xs">候補は自動加算していません。有効な値は明細に反映してください。</p>
                    </details>
                    {privatePhotoJobId && readingReviewImageIndexes(product).length ? <div className="flex flex-wrap gap-2">{readingReviewImageIndexes(product).map(index => <Button key={index} type="button" variant="outline" className="min-h-11 bg-background" aria-label={`${product.product_code} の訂正候補の写真 ${index + 1}を確認`} data-workspace-navigation onClick={() => openPhoto(index)}>原画像 {index + 1}を確認</Button>)}</div> : <p className="text-xs">お手元の元写真と照合してください。</p>}
                    <label className="flex min-h-11 items-center gap-2 text-xs">
                      <input type="checkbox" aria-label={`${product.product_code} の訂正・取消を確認済みにする`} checked={product.readingReviewConfirmed} disabled={!product.canConfirmReadingReview} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], readingReviewConfirmation: event.target.checked ? product.readingReviewFingerprint : "", quantityConfirmation: "" } }))} />
                      原画像と訂正・取消を照合した（変更時は再確認）
                    </label>
                    <p role="status" className="text-xs">{product.readingReviewConfirmed ? "照合確認済み" : "確認するまでコピー・追加できません。"}</p>
                  </section> : null}

                  <fieldset className="mb-3 w-full space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-800 dark:bg-indigo-950/30">
                    <legend className="px-1 text-sm font-bold">数量・リピート</legend>
                    <div className="flex min-h-11 items-center justify-between gap-2 text-sm">
                      <span>リピート計算{product.order_mode === "pattern" && !product.rActive ? "（一部の行）" : ""}</span>
                      <button type="button" role="switch" aria-checked={product.rActive} aria-label={`${product.product_code} の一括リピート計算`} onClick={() => handleToggleMasterRepeat(product.product_code, product.rActive, product.derivedEntries.length)} className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs ${product.rActive ? "text-indigo-700" : "text-muted-foreground"}`}>
                        全行に適用<span className={`flex h-6 w-11 items-center rounded-full p-1 ${product.rActive ? "bg-indigo-600" : "bg-zinc-300"}`}><span className={`h-4 w-4 rounded-full bg-white transition-transform ${product.rActive ? "translate-x-5" : ""}`} /></span>
                      </button>
                    </div>
                    {product.order_mode === "memo" ? <label className="block pt-2 text-sm">予備分の扱い
                      <select aria-label={`${product.product_code} の予備分の扱い`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={product.memo_allowance} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], memoAllowance: event.target.value as MemoProductItem["memo_allowance"], quantityConfirmation: "", readingReviewConfirmation: "" } }))}>
                        <option value="add">メモの数量に予備分を加える</option>
                        <option value="included">メモは発注量まで調整済み（上乗せしない）</option>
                      </select>
                    </label> : null}
                    <p className="text-sm font-semibold tabular-nums" aria-label={`${product.product_code} の数量の計算内訳`}>
                      {product.order_mode === "memo" ? "メモ合計" : product.canConfirm ? "柄合わせ後の必要量" : "参考量（柄合わせ条件を確認）"} {product.total_m}m → {product.allowanceIncluded ? "予備分は調整済み・追加0%" : `予備分 ${product.loss_rate_percent}%`} → 自動計算 {product.automaticQuantity}m（1m単位に切り上げ）
                    </p>
                    {product.manualQuantityActive ? <div className="space-y-2 text-sm">
                      <p>発注数量は手動指定 {product.order_quantity}m を保持しています。柄合わせ・予備分は再上乗せしません。</p>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => { clearManualOrderQuantity(product.product_code); setOrderQuantityInputs(previous => ({ ...previous, [product.product_code]: undefined })); }}>自動計算の数量に戻す</Button>
                    </div> : null}
                    <details><summary className="cursor-pointer text-xs text-muted-foreground">計算・予備分の説明</summary><p className="mt-2 text-xs">メモに柄合わせや予備分が含まれるか不明なときは職人さんに確認してください。</p></details>
                    {product.order_mode === "memo" || basicView ? <label className="flex min-h-11 items-start gap-2 py-2 text-sm">
                      <input type="checkbox" className="mt-1" aria-label={`${product.product_code} のメモと発注数量を確認済みにする`} checked={product.comparisonConfirmed} disabled={!product.canConfirm} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], quantityConfirmation: event.target.checked ? product.confirmationFingerprint : "" } }))} />
                      元メモと発注数量を確認した（変更時は再確認）
                    </label> : null}
                    <details className={`text-xs ${orderCheckColor(product.orderReady, basicView)}`}><summary className="cursor-pointer">{shortOrderStatus(product)}</summary><p role="status" className="mt-2">{orderCheckMessage(product, basicView)}</p></details>
                  </fieldset>


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

                  {product.order_mode === "pattern" ? <div className="mb-6 mt-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3 shadow-sm transition-colors dark:border-indigo-900/30 dark:bg-indigo-900/10 sm:p-4">
                    <div className="text-xs font-bold uppercase tracking-wider text-indigo-800/60 dark:text-indigo-300/60 mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-indigo-900 dark:text-indigo-100 font-semibold text-[11px]">
                        <Layers className="w-3.5 h-3.5" />
                        リピート・高さで一括計算
                      </div>
                      <div className="flex items-center gap-2">
                        {product.rActive && product.override_active && product.comparison.strict.status === "calculated" && (
                           <Badge variant="default" className="text-[10px] px-2 py-0 bg-indigo-600 hover:bg-indigo-700 shadow border-none">適用中</Badge>
                        )}

                      </div>
                    </div>
                    
                    {!basicView ? <><div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <label className="text-xs">寸法の前提
                        <select aria-label={`${product.product_code} の寸法区分`} className="mt-1 block w-full rounded border bg-background p-2" value={product.measurement_basis} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], quantityConfirmation: "", readingReviewConfirmation: "", measurementBasis: event.target.value as MemoProductItem["measurement_basis"] } }))}>
                          <option value="unconfirmed">未確認</option><option value="trim-included">切り代込みの裁断長</option><option value="repeat-adjusted">既に柄調整済み（再計算しない）</option>
                        </select>
                      </label>
                      <label className="text-xs">柄合わせ方式
                        <select aria-label={`${product.product_code} の柄合わせ方式`} className="mt-1 block w-full rounded border bg-background p-2" value={product.pattern_match} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], quantityConfirmation: "", readingReviewConfirmation: "", patternMatch: event.target.value as MemoProductItem["pattern_match"] } }))}>
                          <option value="unconfirmed">未確認</option><option value="straight">ストレートリピート</option><option value="other">半落ち・その他（職人さんに確認）</option>
                        </select>
                      </label>
                    </div>
                    <p className="mb-2 text-xs" aria-label={`${product.product_code} の無地と柄比較`}>
                      元寸法 {product.comparison.strict.totals.originalM === null ? "要確認" : `${product.comparison.strict.totals.originalM}m`} ／ 無地（切り代込み） {product.comparison.strict.totals.plainM === null ? "要確認" : `${product.comparison.strict.totals.plainM}m`} ／ 柄合わせ {product.comparison.strict.totals.patternM === null ? "要確認" : `${product.comparison.strict.totals.patternM}m`}
                    </p>
                    {!product.comparison.premisesAvailable ? <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">参考値です。寸法区分・柄合わせ・リピート値と写真の読み取りを確認してください。柄調整済み・半落ち等は推測計算しません。</p> : null}
                    <label className="mb-3 flex items-start gap-2 text-xs">
                      <input type="checkbox" aria-label={`${product.product_code} の必要量の前提を確認済みにする`} checked={product.comparisonConfirmed} disabled={!product.canConfirm} onChange={event => setOverrides(previous => ({ ...previous, [product.product_code]: { ...previous[product.product_code], quantityConfirmation: event.target.checked ? product.confirmationFingerprint : "" } }))} />
                      採寸・切り代・柄合わせ・予備分と発注数量を確認しました（変更すると再確認）
                    </label>
                    </> : null}
                    <div className={`flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4 transition-opacity duration-300 ${(product.derivedEntries || []).some((e: any) => e.isRepeatActive) ? 'opacity-100' : 'opacity-40'}`}>
                      <div className="flex-1">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">共通高さ (m・任意・全行上書き)</label>
                        <Input 
                          type="number" min="0"
                          step="0.1" 
                          placeholder="例: 2.4" 
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          aria-label={`${product.product_code} の壁の高さ (m)`}
                          value={overrides[product.product_code]?.heightM ?? product.repeat_height_input ?? product.repeat_height_m ?? ""}
                          onChange={(e) => handleOverrideChange(product.product_code, "heightM", e.target.value)}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">リピート (cm)</label>
                        <Input 
                          type="number" min="0"
                          step="0.1" 
                          placeholder="例: 32" 
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          aria-label={`${product.product_code} のリピート (cm)`}
                          value={overrides[product.product_code]?.repeatCm ?? product.repeat_cm_input ?? product.repeat_cm ?? ""}
                          onChange={(e) => handleOverrideChange(product.product_code, "repeatCm", e.target.value)}
                        />
                      </div>
                    </div>
                  </div> : null}

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
                         const qValue = rawQty !== undefined ? rawQty : e.quantity_input ?? e.quantity;
                         const lValue = rawLen !== undefined ? rawLen : e.length_input ?? e.length_m;
                         
                         return (
                           <div
                             key={eidx}
                             data-preserve-editor-input
                             className="group/row flex flex-col gap-1.5 rounded-lg border border-black/5 bg-white/50 px-1.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-white/80 dark:border-white/5 dark:bg-black/50 dark:hover:bg-black/80 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-2 sm:text-sm"
                           >
                              {sourceJobId && Number.isInteger(e.source_image_index) ? <Button type="button" variant="outline" className="h-8 text-xs" aria-label={`${product.product_code} 明細${eidx + 1}の写真を確認`} data-workspace-navigation onClick={() => openPhoto(e.source_image_index)}>写真{e.source_image_index + 1}・明細{e.source_entry_index + 1}を確認</Button> : null}
                              <div className="flex w-full min-w-0 items-center justify-between gap-1 sm:gap-2">
                                <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
                                  {<button
                                    type="button"
                                    onClick={() => handleToggleEntryRepeat(product.product_code, eidx)}
                                    className="-ml-1 flex shrink-0 items-center justify-center p-1.5 sm:m-0 sm:p-0"
                                    title="この行にリピート計算を適用する"
                                    aria-pressed={e.isRepeatActive}
                                    aria-label={`${product.product_code} ${eidx + 1}行目のリピート計算`}
                                  >
                                    <span className={`flex h-3.5 w-6 items-center rounded-full p-px transition-colors ${e.isRepeatActive ? 'bg-indigo-600' : 'bg-black/20 dark:bg-white/20'}`}>
                                      <span className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${e.isRepeatActive ? 'translate-x-[10px]' : ''}`} />
                                    </span>
                                  </button>}

                                  <div 
                                    className="flex w-full min-w-0"
                                    onBlur={(ev) => {
                                      if (!ev.currentTarget.contains(ev.relatedTarget) && !(ev.relatedTarget as HTMLElement | null)?.closest("[data-workspace-navigation],[data-preserve-editor-input]")) {
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
                                          type="number" min="0"
                                          step="0.1" 
                                          className="h-8 w-[4.25rem] border-indigo-300 px-1 text-center text-xs font-bold tabular-nums shadow-inner focus-visible:ring-indigo-500 dark:border-indigo-700 sm:w-[5.5rem] sm:text-sm"
                                          aria-label={`${product.product_code} ${eidx + 1}行目の長さ (m)`}
                                          value={lValue}
                                          onChange={(input) => handleEntryFieldChange(product.product_code, eidx, "entryLengths", input.target.value)}
                                        />
                                        <span className="shrink-0 text-[11px] sm:text-sm">m</span>
                                        <span className="mx-0.5 shrink-0 text-[11px] text-muted-foreground sm:text-sm">×</span>
                                        <Input 
                                          type="number" min="0"
                                          className="h-8 w-[3.25rem] border-indigo-300 px-1 text-center text-xs font-bold tabular-nums shadow-inner focus-visible:ring-indigo-500 dark:border-indigo-700 sm:w-[4rem] sm:text-sm"
                                          aria-label={`${product.product_code} ${eidx + 1}行目の幅数`}
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
                                          {e.length_input !== undefined ? "未入力" : `${e.derived_length}m`}
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
                                    {e.length_input !== undefined || e.quantity_input !== undefined ? "入力確認" : `${e.derived_subtotal}m`}
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
                            aria-label={`${product.product_code} に追加する長さ (m)`}
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
                            aria-label={`${product.product_code} に追加する幅数`}
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
                       <span className="text-xs font-bold opacity-60">予備分 {product.allowanceIncluded ? "調整済み（追加なし）" : `${product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}%`}</span>
                       <span className="text-xs font-bold tabular-nums">
                         <span className="opacity-60 mr-1">計測合計:</span>
                         <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{product.total_m}m</span>
                         <span className="opacity-50 mx-1">/</span>
                         <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{(product.total_m * parseWallpaperWidthM(product.spec)).toFixed(2)}㎡</span>
                       </span>
                    </div>
                  </div>
                    </>
                  )}
                </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>
      </section>
      <div role="tablist" data-workspace-navigation aria-label="解析結果の表示" hidden={keyboardOpen} className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-5xl grid-cols-3 gap-1 border-t bg-background px-2 pt-2 shadow-lg print:hidden" style={{ display: keyboardOpen ? "none" : undefined, paddingBottom: "calc(.5rem + env(safe-area-inset-bottom))" }} onKeyDown={event => {
        const index = views.findIndex(view => view.value === resultView);
        const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); selectView(views[next].value); window.requestAnimationFrame(() => document.getElementById(`${navId}-${views[next].value}-tab`)?.focus());
      }}>
        {views.map(({ value, label }) => <button key={value} id={`${navId}-${value}-tab`} role="tab" type="button" aria-selected={resultView === value} aria-controls={`${navId}-${value}`} tabIndex={resultView === value ? 0 : -1} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs font-bold focus-visible:ring-2 focus-visible:ring-indigo-500 ${resultView === value ? "bg-indigo-950 text-white" : "text-muted-foreground"}`} onClick={() => selectView(value)}>
          {value === "quantity" ? <Layers className="h-5 w-5" /> : value === "edit" ? <Edit3 className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}{label}
        </button>)}
      </div>
    </div>
  );
}
