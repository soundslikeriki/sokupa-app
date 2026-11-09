"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { CopyReviewDialog } from "@/components/CopyReviewDialog";
import { inspectCopyReview, prepareCopyReviewConfirmation, type CopyReviewInput } from "@/lib/copy-review";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyIcon, CheckCircle2, AlertTriangle, Layers, Edit3, Undo2, Globe, Plus, Trash2, Minus, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, ListPlus, ImageIcon, Scale } from "lucide-react";
import { roundMeters } from "@/lib/memo-calculation";
import { orderModeForItem, planMemoOrder } from "@/lib/order-planning";
import { compactReadingReviews, compactReviewReasons, concreteReadingReason, readingNoticesForItem, shortOrderStatus } from "@/lib/order-presentation";
import { numericalOrderStatus } from "@/lib/order-quantity-status";
import { identifyMaterials, materialSignature, originalMaterial } from "@/lib/material-identity";
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

// Persisted local material identity survives SKU edits and display ordering.
function itemEditorKey(items: MemoProductItem[], index: number): string {
  return items[index].client_material_id!;
}


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
  overviewRequest?: number;
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
  resultTools?: ReactNode;
  onMeaningfulEdit?: () => void;
  onEditorBlocked?: (blocked: boolean) => void;
  onResetResult?: (expectedItems: string) => Promise<void>;
  resetDisabledReason?: string;
  onWorkspaceViewChange?: (view: "quantity" | "edit" | "photo") => void;
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

function orderCheckMessage(item: { quantityAssessment: { message: string } }): string {
  return item.quantityAssessment.message;
}

function orderCheckColor(ready: boolean, basicView: boolean): string {
  return ready ? basicView ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300";
}

function numericalStatusForItem(item: { order_quantity: number; order_quantity_input?: string; incompleteMeasurements: boolean;
  repeat_cm_input?: string; repeat_height_input?: string;
  comparison: { hasActiveRepeat: boolean; inputArithmetic: { status: string; totals: { selectedM: string | null } } } }) {
  return numericalOrderStatus({ ordered: item.order_quantity, required: item.comparison.inputArithmetic.totals.selectedM,
    inputsComplete: !item.incompleteMeasurements && item.order_quantity_input === undefined && Number.isFinite(item.order_quantity) && item.order_quantity >= 0,
    conditionsKnown: item.comparison.inputArithmetic.status === "calculated" && (!item.comparison.hasActiveRepeat ||
      item.repeat_cm_input === undefined && item.repeat_height_input === undefined) });
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

export function OrderList({ basicView = false, overviewRequest = 0, items: incomingItems, sourceItems, sourceJobId, readingReviewSourceJobId, notes, siteName = "", onItemsChange, onAddToOrderDraft, onAddAllToOrderDraft, resultTools, onMeaningfulEdit, onEditorBlocked, onResetResult, resetDisabledReason, onWorkspaceViewChange }: OrderListProps) {
  const privatePhotoJobId = sourceJobId ?? readingReviewSourceJobId;
  const materialContext = privatePhotoJobId ?? "legacy-workspace";
  const [materialState, setMaterialState] = useState(() => ({ incoming: incomingItems, context: materialContext,
    items: identifyMaterials([], incomingItems, materialContext) }));
  const items = materialState.items;
  const [publishedMaterials, setPublishedMaterials] = useState(new Map<string, string>());
  const [lastCanonicalMaterials, setLastCanonicalMaterials] = useState(items);
  const [detachedInput, setDetachedInput] = useState<string | null>(null);
  const [copyReviewOpen, setCopyReviewOpen] = useState(false);
  const [copyReviewSession, setCopyReviewSession] = useState(0);
  const copyReviewOpenRef = useRef(false);
  const reviewAfterClose = useRef<(() => void) | null>(null);
  const copyPhotoRef = useRef<HTMLDetailsElement>(null);
  const [photoMetadataJobId, setPhotoMetadataJobId] = useState<string | null>(null);
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
  const photoKey = `${privatePhotoJobId}:${photoIndex}:${photoRequest}:${copyReviewOpen ? "copy" : "photo"}`;
  const boundPhotoCount = photoMetadataJobId === privatePhotoJobId ? photoCount : null;
  useLayoutEffect(() => { currentPhotoRef.current = photoKey; }, [photoKey]);
  useLayoutEffect(() => { if (items.length) onWorkspaceViewChange?.(resultView); }, [resultView, onWorkspaceViewChange, items.length]);
  const views = [{ value: "quantity", label: "概要" }, { value: "edit", label: "数量" }, { value: "photo", label: "メモ画像" }] as const;
  const selectView = (view: typeof resultView, code = selectedProductCode, record = true, scroll = true) => {
    if (view === resultView && code === selectedProductCode) return;
    if (record && (view !== resultView || code !== selectedProductCode)) {
      const previous = window.history.state ?? {};
      if (previous.sokupaResult?.id !== workspaceId) window.history.replaceState({ ...previous, sokupaResult: { id: workspaceId, view: resultView, code: selectedProductCode } }, "");
      window.history.pushState({ ...(window.history.state ?? {}), sokupaResult: { id: workspaceId, view, code } }, "");
    }
    setSelectedProductCode(code); setResultView(view);
    if (!scroll) return;
    window.requestAnimationFrame(() => {
      const panel = resultRoot.current?.querySelector<HTMLElement>(`[data-result-panel="${view}"]`);
      if (panel && panel.getClientRects().length && !document.activeElement?.matches("input,select,textarea")) { panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: "start" }); }
      if (view === "edit") {
        const material = Array.from(panel?.querySelectorAll<HTMLElement>("[data-material-value]") ?? []).find(element => element.dataset.materialId === code);
        material?.scrollIntoView({ block: "start" });
      }
    });
  };
  const lastOverviewRequest = useRef(overviewRequest);
  const overviewNavigation = useRef<() => void>(() => undefined);
  useLayoutEffect(() => { overviewNavigation.current = () => selectView("quantity", selectedProductCode, true, false); });
  useLayoutEffect(() => {
    if (lastOverviewRequest.current === overviewRequest) return;
    lastOverviewRequest.current = overviewRequest; overviewNavigation.current();
  }, [overviewRequest]);
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
    if ((resultView !== "photo" && !copyReviewOpen) || !privatePhotoJobId || boundPhotoCount !== null) return;
    const abort = new AbortController(); setPhotoCountError(false);
    void fetch(`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const json = await response.json(); const count = json.data?.total_images;
      if (!response.ok || !Number.isInteger(count) || count < 1 || count > 5 || (json.data?.id && json.data.id !== privatePhotoJobId)) throw new Error("Invalid image metadata");
      if (!abort.signal.aborted) { setPhotoMetadataJobId(privatePhotoJobId); setPhotoCount(count); setPhotoIndex(index => index ?? 0); }
    }).catch(() => { if (!abort.signal.aborted) setPhotoCountError(true); });
    return () => abort.abort();
  }, [resultView, copyReviewOpen, privatePhotoJobId, boundPhotoCount, photoRequest]);
  useEffect(() => { setPhotoCount(null); setPhotoMetadataJobId(null); setPhotoIndex(null); setPhotoCountError(false); setPhotoError(false); }, [privatePhotoJobId]);
  const [rowResetError, setRowResetError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});
  const [editingCode, setEditingCode] = useState<Record<string, { open: boolean; value: string }>>({});
  const completedCodeEditsRef = useRef(new Set<string>());
  const blurIntentRef = useRef({ navigation: false, row: false });
  useEffect(() => {
    let generation = 0;
    const frames = new Set<number>();
    const frame = (callback: () => void) => {
      const id = window.requestAnimationFrame(() => { frames.delete(id); callback(); });
      frames.add(id);
    };
    const clear = () => { generation++; blurIntentRef.current = { navigation: false, row: false }; };
    // Record intent before a non-focusing button can blur an input (Safari may
    // supply null or an ancestor as relatedTarget). New interaction resets it.
    const record = (event: Event) => {
      generation++;
      const target = event.target instanceof Element ? event.target : null;

      blurIntentRef.current = {
        navigation: Boolean(target?.closest("[data-workspace-navigation]")),
        row: Boolean(target?.closest("[data-preserve-editor-input]")),
      };
    };
    // Let navigation's own focus handoff finish, then expire the intent. A
    // canceled pointer clears immediately, and cannot suppress a later save.
    const finish = () => {
      const current = generation;
      frame(() => frame(() => { if (current === generation) clear(); }));
    };
    for (const type of ["pointerdown", "mousedown", "keydown"]) window.addEventListener(type, record, true);
    for (const type of ["pointerup", "mouseup", "keyup"]) window.addEventListener(type, finish, true);
    window.addEventListener("pointercancel", clear, true);
    return () => {
      for (const type of ["pointerdown", "mousedown", "keydown"]) window.removeEventListener(type, record, true);
      for (const type of ["pointerup", "mouseup", "keyup"]) window.removeEventListener(type, finish, true);
      window.removeEventListener("pointercancel", clear, true);
      frames.forEach(id => window.cancelAnimationFrame(id));
    };
  }, []);
  const navigationBlur = (target: EventTarget | null) => blurIntentRef.current.navigation || (target instanceof Element && Boolean(target.closest("[data-workspace-navigation]")));
  const [lossRates, setLossRates] = useState<Record<string, number | string>>({});
  const [newEntryInputs, setNewEntryInputs] = useState<Record<string, NewEntryInput>>({});
  const [orderQuantityInputs, setOrderQuantityInputs] = useState<Record<string,string | undefined>>({});
  const [manualOrderQuantities, setManualOrderQuantities] = useState<Record<string, number>>({});
  const [collapsedCodes, setCollapsedCodes] = useState<Set<string>>(() => new Set());
  const [collapsedRepeatControls, setCollapsedRepeatControls] = useState<Set<string>>(() => new Set());
  const newEntryInputsRef = useRef<Record<string, NewEntryInput>>({});
  const lastSyncedItemsRef = useRef("");
  const originalItemsRef = useRef(new Map<string, MemoProductItem>());
  const originalContextRef = useRef(materialContext);
  const previousHadItemsRef = useRef(false);

  // Reconcile before commit: a stale overlay must never render/save against a
  // replacement snapshot. Only explicit IDs or unique source rows can follow.
  if (materialState.incoming !== incomingItems || materialState.context !== materialContext) {
    const contextChanged = materialState.context !== materialContext;
    const next = identifyMaterials(contextChanged ? [] : items, incomingItems, materialContext);
    const nextById = new Map(next.map(item => [item.client_material_id!, item]));
    const detached = new Set(items.filter(item => {
      const replacement = nextById.get(item.client_material_id!);
      if (contextChanged || !replacement) return true;
      const signature = materialSignature(replacement);
      return signature !== materialSignature(item) && signature !== publishedMaterials.get(item.client_material_id!);
    }).map(item => item.client_material_id!));
    if (detached.size) {
      const pick = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => detached.has(key)));
      const raw = { overrides: pick(overrides), code: pick(editingCode), lossRates: pick(lossRates),
        newRows: pick(newEntryInputs), quantities: pick(orderQuantityInputs), manual: pick(manualOrderQuantities) };
      // One bounded, downloadable local record; never applied to another material.
      // Existing persisted snapshots and their source data remain untouched.
      if (Object.values(raw).some(record => Object.keys(record).length)) setDetachedInput(JSON.stringify({ version: 1,
        sourceJobId: materialState.context, materials: lastCanonicalMaterials.filter(item => detached.has(item.client_material_id!)), raw },
        (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value, 2));
      const keep = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => !detached.has(key)));
      setOverrides(keep); setEditingCode(keep); setLossRates(keep); setNewEntryInputs(keep);
      setOrderQuantityInputs(keep); setManualOrderQuantities(keep);

    }
    if (contextChanged) { setPublishedMaterials(new Map()); setCollapsedCodes(new Set()); setCollapsedRepeatControls(new Set()); }
    setMaterialState({ incoming: incomingItems, context: materialContext, items: next });
  }
  useLayoutEffect(() => {
    newEntryInputsRef.current = newEntryInputs;
    if (originalContextRef.current !== materialContext) { originalItemsRef.current.clear(); originalContextRef.current = materialContext; }
    for (const item of items) if (!originalItemsRef.current.has(item.client_material_id!)) {
      const original = originalMaterial(item, sourceItems ?? items, items.filter(other => other.product_code === item.product_code).length === 1);
      if (original) originalItemsRef.current.set(item.client_material_id!, cloneMemoProductItem(original));
    }
  }, [items, sourceItems, materialContext, newEntryInputs]);

  const getLossRateForItem = (item: MemoProductItem, editorKey = item.product_code): number => {
    const local = lossRates[editorKey];
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
    const { editorKey, copyReviewInput, derivedEntries, override_active, rActive, total_quantity, comparison, comparisonConfirmed, quantityAssessment, incompleteMeasurements, incompleteSettings, orderReady, outputIssue, confirmationFingerprint, canConfirm, automaticQuantity, manualQuantityActive, allowanceIncluded, readingReviews, readingReviewFingerprint, readingReviewConfirmed, canConfirmReadingReview, ...base } = item;
    return {
      ...base,
      entries: (derivedEntries ?? item.entries ?? []).map((entry: any) => {
        const length_m = toFiniteNumber(entry.base_length ?? entry.length_m);
        const quantity = toFiniteNumber(entry.derived_quantity ?? entry.quantity);
        return {
          source_row_id: entry.source_row_id, source_image_index: entry.source_image_index, source_entry_index: entry.source_entry_index,
          original_formula: entry.original_formula || `${length_m} x ${quantity}`,
          repeat_enabled: entry.configured_repeat_enabled ?? entry.isRepeatActive ?? entry.repeat_enabled ?? false,
          repeat_use_row_length: entry.configured_repeat_use_row_length ?? entry.repeat_use_row_length,
          needs_review: entry.needs_review, review_reason: entry.review_reason,
          length_m, quantity, length_input: entry.length_input, quantity_input: entry.quantity_input,
          subtotal_m: toFiniteNumber(entry.derived_subtotal ?? entry.subtotal_m, Number((length_m * quantity).toFixed(2))),
        };
      }),
    };
  };

  const findItem = (key: string) => items.find((_, index) => itemEditorKey(items, index) === key);
  const applyItemsChange = (nextItems: MemoProductItem[]) => {
    setPublishedMaterials(new Map(nextItems.map(item => [item.client_material_id!, materialSignature(item)])));
    onItemsChange?.(nextItems);
  };

  const beginEditCode = (code: string) => {
    completedCodeEditsRef.current.delete(code);
    setEditingCode((prev) => ({
      ...prev,
      [code]: { open: true, value: findItem(code)?.product_code ?? "" },
    }));
  };

  const invalidateConfirmation = (productCode: string) => {
    setOverrides(previous => ({ ...previous, [productCode]: { ...previous[productCode], quantityConfirmation: "", readingReviewConfirmation: "" } }));
  };

  const clearManualOrderQuantity = (productCode: string) => {
    onMeaningfulEdit?.();
    invalidateConfirmation(productCode);
    setManualOrderQuantities((prev) => {
      return { ...prev, [productCode]: NaN };
    });
  };

  useEffect(() => {
    if (items.length === 0) {
      if (previousHadItemsRef.current) {
        originalItemsRef.current.clear();
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
      // Originals are matched by immutable material/source identity above.
      previousHadItemsRef.current = true;
    }
  }, [items, sourceItems]);

  useEffect(() => {
    const productCodes = items.map(item => item.client_material_id!);
    setCollapsedCodes((current) => {
      const next = pruneCollapsedCodes(current, productCodes);
      if (next.size === current.size && Array.from(next).every((code) => current.has(code))) {
        return current;
      }
      return next;
    });
  }, [items]);

  const saveCodeEdit = async (fromKey: string) => {
    const targetIndex = items.findIndex((_, index) => itemEditorKey(items, index) === fromKey);
    if (targetIndex < 0) return;
    const fromCode = items[targetIndex].product_code;
    if (completedCodeEditsRef.current.has(fromKey)) return;
    completedCodeEditsRef.current.add(fromKey);
    const next = editingCode[fromKey];
    const toCode = (next?.value ?? "").trim().toUpperCase().replace(/[\s\-]+/g, "");
    setEditingCode((prev) => ({ ...prev, [fromKey]: { open: false, value: toCode || fromCode } }));
    if (!toCode || toCode === fromCode) return;
    if (!onItemsChange) return;
    onMeaningfulEdit?.();

    const before = items[targetIndex];
    const updatedItems = items.map((item, index) => index === targetIndex
      ? { ...item, product_code: toCode, quantity_confirmation: "", reading_review_confirmation: "" } : item);
    setSelectedProductCode(fromKey);
    applyItemsChange(updatedItems);

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
    onMeaningfulEdit?.();
    if (!onItemsChange) return;

    const draft = newEntryInputsRef.current[productCode] ?? newEntryInputs[productCode] ?? { length: "", quantity: "" };
    const length = Number(String(draft.length).trim());
    const quantity = Number(String(draft.quantity).trim());
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
    clearManualOrderQuantity(productCode);

    const sourceItems = derivedItems.length > 0 ? derivedItems.map(canonicalizeDerivedItem) : items;
    const updatedItems = sourceItems.map((item, index) => {
      if (itemEditorKey(sourceItems, index) !== productCode) return item;

      const nextEntry = {
        original_formula: `${length} x ${quantity}`,
        length_m: length,
        quantity,
        subtotal_m: Number((length * quantity).toFixed(2)),
      };

      return recalcItem({
        ...item,
        entries: [...(item.entries ?? []), nextEntry],
      }, getLossRateForItem(item, productCode));
    });

    newEntryInputsRef.current = {
      ...newEntryInputsRef.current,
      [productCode]: { length: "", quantity: "" },
    };
    setNewEntryInputs((prev) => ({
      ...prev,
      [productCode]: { length: "", quantity: "" },
    }));
    applyItemsChange(updatedItems);
  };

  const handleDeleteEntry = (productCode: string, entryIndex: number) => {
    onMeaningfulEdit?.();
    if (!onItemsChange) return;
    clearManualOrderQuantity(productCode);

    const sourceItems = derivedItems.length > 0 ? derivedItems.map(canonicalizeDerivedItem) : items;
    const updatedItems = sourceItems.map((item, index) => {
      if (itemEditorKey(sourceItems, index) !== productCode) return item;
      return recalcItem({
        ...item,
        entries: (item.entries ?? []).filter((_, idx) => idx !== entryIndex),
      }, getLossRateForItem(item, productCode));
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

    applyItemsChange(updatedItems);
  };

  const handleToggleEntryRepeat = (productCode: string, entryIndex: number) => {
    clearManualOrderQuantity(productCode);
    setOverrides((prev) => {
      const prevOvr = prev[productCode] || {};
      const item = findItem(productCode)!;
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
      originalItemsRef.current.get(productCode)?.entries ?? [],
      findItem(productCode)?.entries[entryIndex],
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
    const targetIndex = items.findIndex((_, index) => itemEditorKey(items, index) === productCode);
    const original = originalItemsRef.current.get(productCode);
    if (!original) { setRowResetError("元の材料を特定できません。入力は保持しています。メモ画像を確認してください。"); return; }

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

    applyItemsChange(items.map((item, index) => index === targetIndex ? { ...cloneMemoProductItem(original), client_material_id: productCode, quantity_confirmation: "", reading_review_confirmation: "" } : item));
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
    onMeaningfulEdit?.();
    const currentItem = derivedItems.find((item) => item.editorKey === productCode);
    const currentQuantity = toFiniteNumber(currentItem?.order_quantity);
    handleSetOrderQuantity(productCode, currentQuantity + delta);
  };

  const derivedItems = useMemo(() => {
    return items.map((item, itemIndex) => {
      const editorKey = itemEditorKey(items, itemIndex);
      const ovr = overrides[editorKey] || {};
      const eqtys = ovr.entryQtys || {};
      const elengths = ovr.entryLengths || {};
      const eRepeats = ovr.entryRepeatActive || {};
      const lossRate = (() => {
        const local = lossRates[editorKey];
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
      const lossInput = typeof lossRates[editorKey] === "string" ? lossRates[editorKey] as string : typeof lossRates[editorKey] === "number" ? undefined : item.loss_rate_input;
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
        return { id: e.source_row_id ?? `${item.product_code}:${idx}`, length: active && h !== null && h > 0 && typeof elengths[idx] !== "number" && !e.repeat_use_row_length ? h : base,
          quantity: typeof eqtys[idx] === "number" ? eqtys[idx] as number : e.quantity, active,
          lengthInput: typeof elengths[idx] === "string" ? elengths[idx] as string : typeof elengths[idx] === "number" ? undefined : e.length_input,
          quantityInput: typeof eqtys[idx] === "string" ? eqtys[idx] as string : typeof eqtys[idx] === "number" ? undefined : e.quantity_input };
      });
      const manualOrderQuantity = Object.prototype.hasOwnProperty.call(manualOrderQuantities, editorKey) ? (Number.isFinite(manualOrderQuantities[editorKey]) ? manualOrderQuantities[editorKey] : undefined) : item.manual_order_quantity;
      const confirmation = ovr.quantityConfirmation ?? item.quantity_confirmation;
      const readingReviewConfirmation = ovr.readingReviewConfirmation ?? item.reading_review_confirmation;
      const rawOrder = Object.prototype.hasOwnProperty.call(orderQuantityInputs, editorKey) ? orderQuantityInputs[editorKey] : item.order_quantity_input;
      const copyReviewInput: CopyReviewInput = { item: planningItem, rows, repeatCm: r, basis, match, lossRate, manualQuantity: manualOrderQuantity, rawOrder, confirmation, readingReviewConfirmation, globalNotes: notes };
      const plan = planMemoOrder(copyReviewInput);
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
          configured_repeat_use_row_length: typeof elengths[idx] === "number" || e.repeat_use_row_length === true,
          derived_subtotal: Number(subtotal.toFixed(6)), isEditing: ovr.entryEditMode?.[idx] === true, isRepeatActive: row.active };
      });

      if (!item.entries || item.entries.length === 0) {
          masterRepeatStatus = false;
      }



      return {
        ...planningItem,
        editorKey, copyReviewInput,
        measurement_basis: basis, pattern_match: match, quantity_confirmation: confirmation, order_quantity_input: rawOrder,
        reading_reviews: plan.readingReviews.length || item.reading_reviews ? plan.readingReviews : undefined, reading_review_confirmation: readingReviewConfirmation,
        readingReviews: plan.readingReviews, readingReviewFingerprint: plan.readingReviewFingerprint, readingReviewConfirmed: plan.readingReviewConfirmed, canConfirmReadingReview: plan.canConfirmReadingReview,
        comparison, comparisonConfirmed: plan.confirmed, quantityAssessment: plan.assessment,
        incompleteMeasurements: plan.incompleteMeasurements, incompleteSettings: plan.incompleteSettings,
        orderReady: plan.ready, outputIssue: plan.outputIssue, canConfirm: plan.canConfirm, confirmationFingerprint: plan.fingerprint,
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
  const productCodes = useMemo(() => derivedItems.map(item => item.editorKey), [derivedItems]);
  const materialValue = (item: typeof derivedItems[number], index: number) =>
    derivedItems.findIndex(row => row.product_code === item.product_code) === index ? item.product_code : `${item.product_code}::${index}`;
  const materialValues = derivedItems.map(materialValue);
  const activeMaterialValue = materialValues[derivedItems.findIndex(item => item.editorKey === selectedProductCode)] ?? materialValues[0];
  const jumpToMaterial = (value: string) => {
    const index = materialValues.indexOf(value);
    setSelectedProductCode(derivedItems[index]?.editorKey ?? "");
    if (index < 0) return;
    setCollapsedCodes(current => { const next = new Set(current); next.delete(derivedItems[index]?.editorKey); return next; });
    window.requestAnimationFrame(() => document.getElementById(`${navId}-material-${index}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
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
        client_material_id: item.client_material_id,
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
          subtotal_m: entry.subtotal_m, repeat_enabled: entry.repeat_enabled, repeat_use_row_length: entry.repeat_use_row_length, length_input: entry.length_input, quantity_input: entry.quantity_input,
        })),
      })),
    );

    setLastCanonicalMaterials(canonicalItems);
    if (signature === lastSyncedItemsRef.current) return;
    lastSyncedItemsRef.current = signature;
    setPublishedMaterials(new Map(canonicalItems.map(item => [item.client_material_id!, materialSignature(item)])));
    onItemsChange(canonicalItems);
  }, [derivedItems, onItemsChange]);

  const copyCollection = JSON.stringify({ job: privatePhotoJobId, siteName, products: derivedItems.map(item => ({ id: item.editorKey, code: item.product_code,
    sources: item.entries.map(entry => ({ id: entry.source_row_id, image: entry.source_image_index, index: entry.source_entry_index, formula: entry.original_formula })) })).sort((a, b) => a.id.localeCompare(b.id)) });
  const currentReviewScope = { collection: copyCollection,
    identity: JSON.stringify({ job: privatePhotoJobId, siteName, products: derivedItems.map(item => [item.editorKey, item.product_code]).sort((a,b) => a[0].localeCompare(b[0])) }),
    sources: Object.fromEntries(derivedItems.map(item => [item.editorKey, JSON.stringify(item.entries.map(entry => ({
      id: entry.source_row_id, image: entry.source_image_index, index: entry.source_entry_index, formula: entry.original_formula }))) ])),
    filled: derivedItems.length > 0 };
  const [copyReviewScope, setCopyReviewScope] = useState(currentReviewScope);
  // An in-progress whole-list review cannot carry acknowledgements into a different result/list.
  // This guarded same-component reset runs before commit, rather than granting a stale frame.
  if (!copyReviewScope.filled && derivedItems.length > 0) {
    setCopyReviewScope(currentReviewScope);
  } else if (copyReviewScope.filled && copyReviewScope.collection !== copyCollection) {
    const all = copyReviewOpen || copyReviewScope.identity !== currentReviewScope.identity;
    setCopyReviewScope(currentReviewScope);
    setOverrides(previous => ({ ...previous, ...Object.fromEntries(derivedItems.filter(item => all || copyReviewScope.sources[item.editorKey] !== currentReviewScope.sources[item.editorKey]).map(item => [item.editorKey,
      { ...previous[item.editorKey], quantityConfirmation: "", readingReviewConfirmation: "" }])) }));
  }
  const copyReviewRows = useMemo(() => derivedItems.map(item => {
    const id = item.editorKey;
    const context = { sourceJobId: privatePhotoJobId ?? null, siteName, itemKey: id, collectionKey: copyCollection };
    const review = inspectCopyReview(item.copyReviewInput, context);
    const duplicate = derivedItems.filter(other => other.product_code === item.product_code).length > 1;
    return { id, editorKey: item.editorKey, code: item.product_code, quantity: item.order_quantity,
      quantityIncomplete: item.order_quantity_input !== undefined || !Number.isFinite(item.order_quantity) || item.order_quantity < 0,
      token: review.token, ready: item.orderReady, readingReviewed: item.readingReviewConfirmed, notices: readingNoticesForItem(item), numericalStatus: numericalStatusForItem(item),
      confirmable: review.confirmable && !duplicate, blockedMessage: item.outputIssue ?? "",
      reviews: review.plan.readingReviews, imageIndexes: [...new Set([...readingReviewImageIndexes(item),
        ...item.entries.map(entry => entry.source_image_index).filter((index): index is number => Number.isSafeInteger(index) && index !== undefined && index >= 0)])], input: item.copyReviewInput, context };
  }), [derivedItems, privatePhotoJobId, siteName, copyCollection]);
  const copyBatchToken = JSON.stringify(copyReviewRows.map(row => ({ id: row.id, token: row.token })));
  const liveCopyReview = useRef({ rows: copyReviewRows, batch: copyBatchToken, items: derivedItems, siteName, view: resultView });
  useLayoutEffect(() => { liveCopyReview.current = { rows: copyReviewRows, batch: copyBatchToken, items: derivedItems, siteName, view: resultView }; }, [copyReviewRows, copyBatchToken, derivedItems, siteName, resultView]);
  const openCopyReview = () => {
    if (copyReviewOpenRef.current) return;
    copyReviewOpenRef.current = true;
    setCopyReviewScope(currentReviewScope);
    window.history.pushState({ ...(window.history.state ?? {}), sokupaCopyReview: workspaceId }, "");
    setCopyReviewSession(value => value + 1);
    setCopyReviewOpen(true);
  };
  const closeCopyReview = (after?: () => void) => {
    if (!copyReviewOpenRef.current) return;
    copyReviewOpenRef.current = false; setCopyReviewOpen(false);
    if (typeof window.history.state?.sokupaCopyReview === "string") { reviewAfterClose.current = after ?? null; window.history.back(); }
    else after?.();
  };
  useEffect(() => {
    if (!copyReviewOpenRef.current && typeof window.history.state?.sokupaCopyReview === "string") {
      const state = { ...window.history.state }; delete state.sokupaCopyReview;
      window.history.replaceState(state, "");
    }
    const restore = (event: PopStateEvent) => {
      const opened = event.state?.sokupaCopyReview === workspaceId;
      if (opened && !copyReviewOpenRef.current) setCopyReviewSession(value => value + 1);
      copyReviewOpenRef.current = opened; setCopyReviewOpen(opened);
      if (!opened) { const after = reviewAfterClose.current; reviewAfterClose.current = null; after?.(); }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [workspaceId]);
  const applyReviewConfirmations = (selections: { id: string; token: string }[], batch: string) => {
    const current = liveCopyReview.current;
    if (!copyReviewOpenRef.current
      || batch !== current.batch || !selections.length || new Set(selections.map(row => row.id)).size !== selections.length) return false;
    const changes = selections.map(selection => {
      const row = current.rows.find(row => row.id === selection.id);
      if (!row || !row.confirmable || row.token !== selection.token) return null;
      const acknowledgement = prepareCopyReviewConfirmation(row.input, row.context, selection.token);
      return acknowledgement ? { key: row.editorKey, acknowledgement } : null;
    });
    if (changes.some(row => row === null)) return false;
    onMeaningfulEdit?.();
    setOverrides(previous => {
      const next = { ...previous };
      for (const change of changes) if (change) next[change.key] = { ...previous[change.key],
        readingReviewConfirmation: change.acknowledgement.readingReviewConfirmation ?? previous[change.key]?.readingReviewConfirmation,
        quantityConfirmation: change.acknowledgement.quantityConfirmation };
      return next;
    });
    return true;
  };
  const applyCopyReview = (selections: { id: string; token: string }[], batch: string) => applyReviewConfirmations(selections, batch);
  const copyOrderText = async (expectedBatch: string) => {
    const current = liveCopyReview.current;
    if (!copyReviewOpenRef.current || expectedBatch !== current.batch || !current.items.length || current.items.some(item => !item.orderReady)) return false;
    try {
      const text = buildOrderRequestText(current.items, current.siteName);
      // No await/state update before this call: preserve iOS's explicit user gesture.
      await navigator.clipboard.writeText(text);
      alert("発注用テキストをコピーしました！"); return true;
    } catch {
      alert("コピーに失敗しました。"); return false;
    }
  };
  const sourcePhoto = (review = false) => !privatePhotoJobId ? <p role="status">この結果にはメモ画像の参照がありません。お手元の写真と照合してください。</p> : photoCountError ? <div role="alert"><p>メモ画像の一覧を取得できませんでした。結果と編集は保持しています。</p><Button type="button" variant="outline" onClick={() => { setPhotoCountError(false); setPhotoRequest(value => value + 1); }}>写真一覧を再取得</Button></div> : boundPhotoCount === null ? <p role="status">メモ画像を確認中…</p> : <>
    <div className="flex flex-wrap gap-2" role="group" aria-label="メモ画像を選択">{Array.from({ length: boundPhotoCount }, (_, index) => <Button key={index} type="button" variant={photoIndex === index ? "default" : "outline"} aria-pressed={photoIndex === index} data-workspace-navigation onClick={() => { if (review) { setPhotoError(false); setPhotoIndex(index); } else openPhoto(index); }}>写真 {index + 1}</Button>)}</div>
    {photoIndex !== null && (photoIndex < 0 || photoIndex >= boundPhotoCount) ? <p role="alert">指定されたメモ画像が見つかりません。上の写真番号から選び直してください。</p> : photoError ? <div role="alert"><p>写真を取得できませんでした。通信とログイン状態を確認してください。</p><Button type="button" variant="outline" onClick={() => { setPhotoError(false); setPhotoRequest(value => value + 1); }}>写真を再取得</Button></div> : <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img key={photoKey} className={`${review ? "max-h-[45dvh]" : "max-h-[70dvh]"} w-full rounded-lg object-contain`} alt={`解析元の写真 ${(photoIndex ?? 0) + 1}`} src={`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}/images/${photoIndex ?? 0}`} onError={() => { if (currentPhotoRef.current === photoKey) setPhotoError(true); }} />
      <a className="inline-block min-h-11 content-center text-sm underline" href={`/api/analysis-jobs/${encodeURIComponent(privatePhotoJobId)}/images/${photoIndex ?? 0}`} target="_blank" rel="noopener noreferrer">写真を別画面で拡大</a>
    </>}
  </>;

  const resetEditorBlocked = Object.entries(editingCode).some(([code, draft]) => draft.open && draft.value !== findItem(code)?.product_code)
    || Object.values(newEntryInputs).some(draft => Object.values(draft).some(value => value !== "" && value !== undefined))
    || derivedItems.some(item => item.incompleteMeasurements || item.incompleteSettings || item.order_quantity_input !== undefined);
  useEffect(() => { onEditorBlocked?.(resetEditorBlocked); return () => onEditorBlocked?.(false); }, [onEditorBlocked, resetEditorBlocked]);

  if (items.length === 0) return null;

  return (
    <div ref={resultRoot} className="space-y-3 pb-[calc(5rem+env(safe-area-inset-bottom))] print:pb-0" onChangeCapture={event => {
      const target = event.target as HTMLElement, label = target.getAttribute("aria-label") ?? "";
      if (target.closest("dialog") || label === "品番を編集" || label.includes("に追加する") || target.closest("select[data-workspace-navigation]")) return;
      onMeaningfulEdit?.();
    }} onKeyDown={event => {
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
          <Button type="button" aria-label="確認してコピー" data-workspace-navigation aria-describedby={`${navId}-copy-status`} onClick={openCopyReview} className="min-h-11 gap-2">
            <CopyIcon className="h-4 w-4" />確認してコピー
          </Button>
        </CardHeader>
        <CardContent id={`${navId}-copy-status`} className="px-3 pb-3 pt-0 text-xs text-muted-foreground">{derivedItems.some(item => !item.orderReady) ? "候補・写真・数量をまとめて確認できます。" : "指定した発注数量をコピーできます。注意は別に確認できます。"}</CardContent>
      </Card>

      {reviewReasonGroups.length ? <details aria-label="読み取りの注意" className="rounded-lg border px-3 py-2 text-xs">
        <summary data-workspace-navigation className="min-h-8 cursor-pointer">読み取りの確認 {reviewReasonGroups.length}件</summary>
        <ul className="mt-2 space-y-2">{reviewReasonGroups.map(({reason,codes}) => <li key={reason}><p className="font-semibold">対象：{codes.join("・")}</p><p>{reason}</p></li>)}</ul>
        <button type="button" data-workspace-navigation className="min-h-11 underline" onClick={openCopyReview}>候補・写真・数量をまとめて確認</button>
      </details> : null}

      <Card className="border-none bg-white/70 shadow-lg ring-1 ring-inset ring-indigo-500/15 backdrop-blur-xl dark:bg-zinc-900/70">
        <CardHeader className="px-3 pb-2 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-indigo-900 dark:text-indigo-100 sm:text-base">
            <Scale className="h-4 w-4" aria-hidden="true" />
            必要量との比較（自動）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 px-3 pb-4 pt-0 sm:px-6 sm:pb-5">
          {derivedItems.map((item, index) => {
            const code = String(item.product_code ?? "").trim() || "不明";
            const quantity = toFiniteNumber(item.order_quantity);
            const review = copyReviewRows[index];
            const duplicate = derivedItems.filter(other => other.product_code === item.product_code).length > 1;
            const readingAttention = item.readingReviews.length && !item.readingReviewConfirmed ? "訂正・取消の注意" : review.notices.length ? "読み取りの注意" : "";
            const numeric = numericalStatusForItem(item);
            return (
              <div
                key={review.id}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-black/5 bg-black/[0.03] px-2 py-1.5 dark:border-white/5 dark:bg-white/[0.04] sm:px-3"
              >
                <p className="min-w-0 flex-1 break-words text-sm font-bold text-zinc-900 dark:text-zinc-100">{code}</p>
                <p className="shrink-0 text-xl font-extrabold tabular-nums" aria-label={`${code} の一覧発注数量`}>{item.order_quantity_input !== undefined || !Number.isFinite(item.order_quantity) || quantity < 0 ? "未確定" : `${quantity}m`}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 rounded-md bg-white p-0 dark:bg-black"
                    onClick={() => handleAdjustOrderQuantity(item.editorKey, -1)}
                    disabled={quantity <= 0 || item.order_quantity_input !== undefined}
                    aria-label={`${code} の発注数量を1m減らす`}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 rounded-md bg-white p-0 dark:bg-black"
                    disabled={item.order_quantity_input !== undefined}
                    onClick={() => handleAdjustOrderQuantity(item.editorKey, 1)}
                    aria-label={`${code} の発注数量を1m増やす`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex w-full items-center justify-between gap-2">
                  <p className={`text-xs ${numeric.state === "sufficient" ? "font-semibold text-emerald-700 dark:text-emerald-300" : numeric.state === "shortfall" ? "font-semibold text-rose-700 dark:text-rose-300" : "text-muted-foreground"}`} role="status" aria-label={`${code} の発注量チェック`}>
                    <span aria-hidden="true">{numeric.state === "sufficient" ? "✅ " : numeric.state === "shortfall" ? "⚠️ " : "－ "}</span>{numeric.text}
                  </p>
                  <button type="button" className="min-h-11 text-xs underline" aria-label={`${code} を確認・編集`} data-workspace-navigation onClick={() => { setCollapsedCodes(current => { const next = new Set(current); next.delete(derivedItems[index]?.editorKey); return next; }); selectView("edit", item.editorKey); }}>確認・編集</button>
                </div>
                {item.comparison.inputArithmeticNotice ? <p className="w-full text-xs text-amber-800 dark:text-amber-300" aria-label={`${code} の計算条件の注意`}>{item.comparison.inputArithmeticNotice}</p> : null}
                {!review.ready || readingAttention || duplicate ? <p className="flex w-full items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-300" aria-label={`${code} の発注時の注意`}>
                  <span>{review.blockedMessage || readingAttention || "同品番は別行で表示・追加時に統合を選択"}</span>
                  <button type="button" data-workspace-navigation className="min-h-11 shrink-0 underline" aria-label={`${code} の発注時の注意を見る`} onClick={openCopyReview}>注意を見る</button>
                </p> : null}
                <details className="w-full text-xs" aria-label={`${code} の一覧確認詳細`}>
                  <summary data-workspace-navigation className="min-h-11 cursor-pointer content-center underline">{review.reviews.length ? `訂正候補 ${review.reviews.length}件・メモ画像` : "メモ画像"}</summary>
                  <div className="space-y-2 break-words rounded-lg bg-amber-500/10 p-2">
                    {review.notices.map((notice, index) => <p key={`notice-${index}`}>{notice}</p>)}
                    {review.reviews.length ? <p className="font-semibold">対象：{code}（候補は自動加算しません）</p> : null}
                    {review.reviews.map((evidence, evidenceIndex) => <div key={evidenceIndex}>
                      {evidence.reason.length > 140 ? <details><summary data-workspace-navigation className="min-h-11 cursor-pointer">{evidence.reason.slice(0, 100)}…（全文）</summary><p>{evidence.reason}</p></details> : <p>{evidence.reason}</p>}
                      {evidence.candidate_formulas.length ? <p className="font-semibold">候補：{evidence.candidate_formulas.join(" ／ ")}</p> : null}
                      <p>{evidence.source_image_index === undefined ? "写真の対応も照合してください" : `写真${evidence.source_image_index + 1}`}</p>
                    </div>)}
                    {privatePhotoJobId && review.imageIndexes.length ? <div className="flex flex-wrap gap-2">{review.imageIndexes.map(imageIndex => <Button key={imageIndex} type="button" variant="outline" data-workspace-navigation className="min-h-11 text-xs" aria-label={`${code} の一覧から写真${imageIndex + 1}を確認`} onClick={() => openPhoto(imageIndex)}>写真{imageIndex + 1}を確認</Button>)}</div>
                      : privatePhotoJobId ? <Button type="button" variant="outline" data-workspace-navigation className="min-h-11 text-xs" aria-label={`${code} の一覧からメモ画像を確認`} onClick={() => openPhoto(0)}>メモ画像を確認</Button>
                        : <p>お手元のメモ画像と照合してください。</p>}
                  </div>
                </details>
              </div>
            );
          })}
        </CardContent>
      </Card>


      <p className="px-2 text-xs text-muted-foreground">必要量と入力値の比較です。予備分込みの推奨量や施工の保証とは異なります。</p>
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
        <h2 className="text-xl font-bold">メモ画像</h2>
        {!copyReviewOpen ? sourcePhoto() : null}
        {resultTools}
        {onResetResult ? <div className="space-y-2 rounded-xl border p-3 text-sm">
          <Button type="button" variant="outline" className="min-h-11" data-workspace-navigation disabled={Boolean(resetDisabledReason) || resetEditorBlocked}
            onClick={() => void onResetResult(JSON.stringify(derivedItems.map(canonicalizeDerivedItem)))}>すべてリセット</Button>
          <p className="text-xs text-muted-foreground">{resetEditorBlocked ? "入力中の品番・未追加の行・未完了の数値を確定または取消してから操作してください。" : resetDisabledReason || "解析結果・現場名・発注リスト全体をリセット。確認後、直前の状態を端末に1件残します。"}</p>
        </div> : null}
      </section>
      <section id={`${navId}-edit`} data-result-panel="edit" role="tabpanel" aria-labelledby={`${navId}-edit-tab`} tabIndex={-1} hidden={resultView !== "edit"} className="scroll-mt-4 space-y-3 outline-none print:block">
        <h2 className="text-xl font-bold">数量</h2>
        <label className="block text-sm font-semibold">編集する品番<select aria-label="編集する品番" data-workspace-navigation className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" value={activeMaterialValue} onChange={event => jumpToMaterial(event.target.value)}>{groups.map(group => <optgroup key={group.label} label={group.label}>{group.rows.map(product => <option key={product.editorKey} value={materialValue(product, derivedItems.indexOf(product))}>{product.product_code}{derivedItems.filter(item => item.product_code === product.product_code).length > 1 ? `（${derivedItems.indexOf(product) + 1}行目）` : ""}</option>)}</optgroup>)}</select></label>
      <details className="rounded-xl border bg-background p-3 text-sm" aria-label="読み取り・計算の説明">
        <summary data-workspace-navigation className="min-h-6 cursor-pointer font-medium">読み取りの説明{reviewReasonGroups.length ? "（確認あり）" : ""}</summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>自動計算は予備分を加えて1m単位に切り上げます。調整済み・手動指定の発注量には再上乗せしません。</p>
          {reviewReasonGroups.length ? <ul className="space-y-2 break-words text-amber-800 dark:text-amber-200">{reviewReasonGroups.map(({reason,codes}) => <li key={reason}><span className="font-semibold">{codes.join("・")}</span> — {reason}</li>)}</ul> : null}
          {notes && concreteReadingReason(notes) && !reviewReasonGroups.some(row => row.reason.includes(notes.trim())) ? <p>メモ備考：{notes}</p> : null}
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
          data-workspace-navigation onClick={() => setCollapsedCodes((current) => toggleAllCollapsedCodes(current, productCodes))}
          aria-label={allCodesCollapsed ? "すべての材料詳細を展開" : "すべての材料詳細を省略"}
        >
          {allCodesCollapsed ? <ChevronsDown className="h-4 w-4" /> : <ChevronsUp className="h-4 w-4" />}
          {allCodesCollapsed ? "すべて展開" : "すべて省略"}
        </Button>
      </div>

      {detachedInput ? <details className="rounded-lg border p-3 text-sm"><summary data-workspace-navigation className="min-h-11 cursor-pointer">切り替え前の入力を保全しました</summary>
        <p>対応を特定できない編集は別の材料に適用していません。</p>
        <button type="button" data-workspace-navigation className="min-h-11 underline" onClick={() => {
          const url = URL.createObjectURL(new Blob([detachedInput], { type: "application/json" }));
          const link = document.createElement("a"); link.href = url; link.download = "sokupa-material-inputs.json"; link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>保全した入力を書き出す</button></details> : null}
      {rowResetError ? <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{rowResetError}</p> : null}
      <div className="space-y-4 sm:space-y-6">
        {groups.map((group) => (
          <Card key={group.label} className="border-none shadow-md overflow-hidden bg-white/60 print:block dark:bg-zinc-900/60 backdrop-blur-md">
            <CardHeader className="flex flex-row items-center justify-between border-b border-black/5 bg-black/5 px-3 py-3 dark:border-white/5 dark:bg-white/5 sm:px-6 sm:py-4">
              <CardTitle className="text-base font-bold tracking-tight sm:text-lg">{group.label}</CardTitle>
              <Badge variant="secondary" className="px-3 py-1 font-bold rounded-full bg-white dark:bg-black text-xs shadow-sm">
                {group.rows.length} 品番
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {group.rows.map((product, idx) => {
                const materialIndex = derivedItems.indexOf(product);
                const materialKey = product.editorKey;
                const isCollapsed = collapsedCodes.has(materialKey);
                const commonHeightInput = overrides[product.editorKey]?.heightM ?? product.repeat_height_input;
                const commonHeightInvalid = typeof commonHeightInput === "string" && commonHeightInput !== "";
                const individualHeightRows = product.derivedEntries.filter((entry: any) => entry.isRepeatActive && entry.configured_repeat_use_row_length).length;
                const activeRepeatRows = product.derivedEntries.filter((entry: any) => entry.isRepeatActive).length;
                const heightStatus = commonHeightInvalid ? `共通高さの入力を確認${!activeRepeatRows ? "（リピートOFF・未使用）" : ""}`
                  : product.repeat_height_m && product.repeat_height_m > 0
                    ? !activeRepeatRows ? `共通高さ ${product.repeat_height_m}m（リピートOFF）`
                      : individualHeightRows === activeRepeatRows ? `各行の個別寸法で計算（共通高さ ${product.repeat_height_m}m は未使用）`
                        : `共通高さ ${product.repeat_height_m}m${individualHeightRows ? `・個別寸法${individualHeightRows}行を優先` : "を使用"}`
                    : "各行の寸法で計算";
                const repeatDetailsId = `${navId}-repeat-${product.editorKey}`;
                const repeatControlsId = `${repeatDetailsId}-controls`;
                const repeatControlsOpen = !collapsedRepeatControls.has(repeatControlsId);
                return (
                <div aria-label={`${product.product_code} の材料 ${materialIndex + 1}`} data-material-index={materialIndex} data-material-id={product.editorKey} data-material-value={materialValue(product, materialIndex)} id={`${navId}-material-${materialIndex}`} key={product.editorKey} className={`print:block px-3 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 ${idx !== 0 ? "border-t border-black/5 dark:border-white/5" : ""} transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]`}>
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
                        {product.readingReviews.length && !product.readingReviewConfirmed ? <p className="mt-2 text-xs font-semibold text-amber-800 dark:text-amber-300">訂正・取消 要確認</p> : null}
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
                        data-workspace-navigation onClick={() => setCollapsedCodes((current) => toggleCollapsedCode(current, materialKey))}
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
                        {editingCode[product.editorKey]?.open ? (
                          <Input
                            value={editingCode[product.editorKey]?.value ?? product.product_code}
                            onChange={(e) =>
                              setEditingCode((prev) => ({
                                ...prev,
                                [product.editorKey]: { open: true, value: e.target.value },
                              }))
                            }
                            onBlur={event => { if (!navigationBlur(event.relatedTarget)) void saveCodeEdit(product.editorKey); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void saveCodeEdit(product.editorKey);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                completedCodeEditsRef.current.add(product.product_code);
                                setEditingCode((prev) => ({
                                  ...prev,
                                  [product.editorKey]: { open: false, value: product.product_code },
                                }));
                              }
                            }}
                            className="h-9 w-[10.5rem] px-2 text-base font-extrabold tabular-nums sm:h-10 sm:w-[12rem] sm:text-xl"
                            aria-label="品番を編集"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEditCode(product.editorKey)}
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
                      ) : product.readingReviews.length && !product.readingReviewConfirmed || product.review_reasons?.some((reason: string) => concreteReadingReason(reason) && !reason.startsWith("画像：")) ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-600/30 bg-amber-500/10 gap-1 px-2 py-0.5 ml-1">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span className="text-xs">要確認</span>
                        </Badge>
                      ) : (
                        <Badge variant="outline" className={`gap-1 px-2 py-0.5 ml-1 ${!basicView && product.orderReady ? "text-emerald-600 border-emerald-600/30 bg-emerald-500/10" : "text-muted-foreground border-border"}`}>
                          {!basicView && product.orderReady ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Layers className="w-3.5 h-3.5" />}
                          <span className="text-xs">{product.orderReady ? "追加・コピー可能" : "数量を確認"}</span>
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
                        data-workspace-navigation onClick={() => setCollapsedCodes((current) => toggleCollapsedCode(current, materialKey))}
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
                          onClick={() => handleAdjustLossRate(product.editorKey, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, -1)}
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
                          value={lossRates[product.editorKey] ?? product.loss_rate_input ?? product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT}
                          disabled={product.allowanceIncluded}
                          onChange={(e) => handleLossRateChange(product.editorKey, e.target.value)}
                          aria-label={`${product.product_code} のロス率を入力`}
                        />
                        <span className="text-center text-sm font-semibold opacity-60">%</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          disabled={product.allowanceIncluded}
                          onClick={() => handleAdjustLossRate(product.editorKey, product.loss_rate_percent ?? DEFAULT_LOSS_RATE_PERCENT, 1)}
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
                          onClick={() => handleAdjustOrderQuantity(product.editorKey, -1)}
                          disabled={product.order_quantity <= 0 || product.order_quantity_input !== undefined}
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
                          onChange={(e) => handleOrderQuantityInput(product.editorKey, e.target.value)}
                          aria-label={`${product.product_code} の発注数量を入力`}
                        />
                        <span className="text-center text-sm font-semibold opacity-60">m</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg bg-white p-0 dark:bg-black"
                          disabled={product.order_quantity_input !== undefined}
                          onClick={() => handleAdjustOrderQuantity(product.editorKey, 1)}
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
                  {product.readingReviews.length ? <div className="mb-3 w-full text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span>{product.readingReviewConfirmed ? "訂正・取消 照合済み" : "訂正・取消 要確認"}</span><Button type="button" variant="outline" className="min-h-11 text-xs" data-workspace-navigation aria-label={`${product.product_code} の確認画面を開く`} onClick={openCopyReview}>確認してコピー</Button></div>
                    <details aria-label={`${product.product_code} の個別照合詳細`}><summary data-workspace-navigation className="min-h-8 cursor-pointer">この品番の照合詳細</summary><section aria-label={`${product.product_code} の訂正・取消の確認`} className="mt-2 w-full space-y-2 text-xs">

                    <details aria-label={`${product.product_code} の読み取り詳細`}>
                      <summary data-workspace-navigation className="min-h-8 cursor-pointer text-xs font-medium">読み取りの詳細を表示</summary>
                      <div className="mt-2 space-y-2 break-words text-xs">{compactReadingReviews(product.readingReviews).map((review, index) => <div key={index}>
                        <p>{review.reason}</p>
                        {review.candidate_formulas.length ? <ul className="list-inside list-disc font-semibold">{review.candidate_formulas.map(formula => <li key={formula}>{formula}</li>)}</ul> : <p>訂正箇所を原画像で確認してください。</p>}
                      </div>)}</div>
                      <p className="mt-2 text-xs">候補は自動加算していません。有効な値は明細に反映してください。</p>
                    </details>
                    {privatePhotoJobId && readingReviewImageIndexes(product).length ? <div className="flex flex-wrap gap-2">{readingReviewImageIndexes(product).map(index => <Button key={index} type="button" variant="outline" className="min-h-11 bg-background" aria-label={`${product.product_code} の訂正候補の写真 ${index + 1}を確認`} data-workspace-navigation onClick={() => openPhoto(index)}>原画像 {index + 1}を確認</Button>)}</div> : <p className="text-xs">お手元のメモ画像と照合してください。</p>}
                    <label className="flex min-h-11 items-center gap-2 text-xs">
                      <input type="checkbox" aria-label={`${product.product_code} の訂正・取消を確認済みにする`} checked={product.readingReviewConfirmed} disabled={!product.canConfirmReadingReview} onChange={event => setOverrides(previous => ({ ...previous, [product.editorKey]: { ...previous[product.editorKey], readingReviewConfirmation: event.target.checked ? product.readingReviewFingerprint : "", quantityConfirmation: "" } }))} />
                      原画像と訂正・取消を照合した（変更時は再確認）
                    </label>
                    <p role="status" className="text-xs">{product.readingReviewConfirmed ? "照合確認済み" : "照合の記録は任意です。発注数量はそのまま出力できます。"}</p>
                  </section></details></div> : null}

                  <fieldset aria-label={`${product.product_code} の数量・リピート`} className="mb-3 w-full space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-800 dark:bg-indigo-950/30">
                    <legend className="w-full px-1 text-sm font-bold">
                      <button type="button" data-workspace-navigation aria-label={`${product.product_code} の数量・リピート`} aria-expanded={repeatControlsOpen} aria-controls={repeatControlsId}
                        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        onClick={event => {
                          event.currentTarget.focus({ preventScroll: true });
                          setCollapsedRepeatControls(previous => {
                            const next = new Set(previous);
                            if (next.has(repeatControlsId)) next.delete(repeatControlsId); else next.add(repeatControlsId);
                            return next;
                          });
                        }}>
                        <span>数量・リピート</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">{repeatControlsOpen ? "閉じる" : "開く"}{repeatControlsOpen ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}</span>
                      </button>
                    </legend>
                    {!repeatControlsOpen ? <p className="text-xs text-muted-foreground">{heightStatus}・{shortOrderStatus(product)}</p> : null}
                    <div id={repeatControlsId} hidden={!repeatControlsOpen} className="space-y-2">
                    <div className="flex min-h-11 items-center justify-between gap-2 text-sm">
                      <span>リピート計算{product.order_mode === "pattern" && !product.rActive ? "（一部の行）" : ""}</span>
                      <button type="button" role="switch" aria-checked={product.rActive} aria-label={`${product.product_code} の一括リピート計算`} onClick={() => handleToggleMasterRepeat(product.editorKey, product.rActive, product.derivedEntries.length)} className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs ${product.rActive ? "text-indigo-700" : "text-muted-foreground"}`}>
                        全行に適用<span className={`flex h-6 w-11 items-center rounded-full p-1 ${product.rActive ? "bg-indigo-600" : "bg-zinc-300"}`}><span className={`h-4 w-4 rounded-full bg-white transition-transform ${product.rActive ? "translate-x-5" : ""}`} /></span>
                      </button>
                    </div>
                    <div className="py-1">
                      <div className="max-w-xs">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">リピート (cm)</label>
                        <Input
                          type="number" min="0"
                          step="0.1"
                          placeholder="例: 32"
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          aria-label={`${product.product_code} のリピート (cm)`}
                          value={overrides[product.editorKey]?.repeatCm ?? product.repeat_cm_input ?? product.repeat_cm ?? ""}
                          onChange={(e) => handleOverrideChange(product.editorKey, "repeatCm", e.target.value)}
                        />
                      </div>
                    </div>
                      <div className="flex-1">
                        <label className="text-[10px] font-bold opacity-60 mb-1.5 block ml-1 text-indigo-900 dark:text-indigo-100">共通高さ (m・任意・個別指定を除く)</label>
                        <Input
                          type="number" min="0"
                          step="0.1"
                          placeholder="例: 2.4"
                          className="h-10 text-sm bg-white dark:bg-black border-indigo-200 dark:border-indigo-800 focus-visible:ring-indigo-500 font-medium tabular-nums"
                          aria-label={`${product.product_code} の壁の高さ (m)`}
                          value={overrides[product.editorKey]?.heightM ?? product.repeat_height_input ?? product.repeat_height_m ?? ""}
                          onChange={(e) => handleOverrideChange(product.editorKey, "heightM", e.target.value)}
                        />
                      </div>
                    <p className="text-xs text-muted-foreground">未入力なら各行の寸法を使用します。個別に編集した行は、その寸法を優先します。</p>
                    <p className="text-xs font-medium" aria-label={`${product.product_code} の高さの適用状態`}>{heightStatus}</p>
                    {product.order_mode === "pattern" ? <button type="button" data-workspace-navigation className="min-h-11 text-left text-xs underline" aria-controls={repeatDetailsId} aria-label={`${product.product_code} のリピート条件を確認`} onClick={() => {
                      const details = document.getElementById(repeatDetailsId);
                      if (details instanceof HTMLDetailsElement) { details.open = true; details.querySelector("summary")?.focus({ preventScroll: true }); details.scrollIntoView({ block: "nearest" }); }
                    }}>{shortOrderStatus(product) === "追加・コピー可能" ? "詳細設定を開く" : `${shortOrderStatus(product)}・設定を開く`}</button> : null}
                    {product.order_mode === "memo" ? <label className="block pt-2 text-sm">予備分の扱い
                      <select aria-label={`${product.product_code} の予備分の扱い`} className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={product.memo_allowance} onChange={event => setOverrides(previous => ({ ...previous, [product.editorKey]: { ...previous[product.editorKey], memoAllowance: event.target.value as MemoProductItem["memo_allowance"], quantityConfirmation: "", readingReviewConfirmation: "" } }))}>
                        <option value="add">メモの数量に予備分を加える</option>
                        <option value="included">メモは発注量まで調整済み（上乗せしない）</option>
                      </select>
                    </label> : null}

                    {product.manualQuantityActive ? <div className="space-y-2 text-sm">
                      <p>発注数量は手動指定 {product.order_quantity}m を保持しています。柄合わせ・予備分は再上乗せしません。</p>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => { clearManualOrderQuantity(product.editorKey); setOrderQuantityInputs(previous => ({ ...previous, [product.editorKey]: undefined })); }}>自動計算の数量に戻す</Button>
                    </div> : null}
                    <details aria-label={`${product.product_code} の計算説明`}><summary data-workspace-navigation className="min-h-11 cursor-pointer text-xs text-muted-foreground">計算・予備分の説明</summary>
                    <p className="mt-2 text-xs font-semibold tabular-nums" aria-label={`${product.product_code} の数量の計算内訳`}>
                      {product.order_mode === "memo" ? "メモ合計" : product.comparison.strict.status === "calculated" ? "柄合わせ後の必要量" : "参考量（柄合わせ条件を確認）"} {product.total_m}m → {product.allowanceIncluded ? "予備分は調整済み・追加0%" : `予備分 ${product.loss_rate_percent}%`} → 自動計算 {product.automaticQuantity}m（1m単位に切り上げ）
                    </p>
                      <p className="mt-2 text-xs">メモに柄合わせや予備分が含まれるか不明なときは職人さんに確認してください。</p>
                    </details>
                    <details className={`text-xs ${orderCheckColor(product.orderReady, basicView)}`}><summary data-workspace-navigation className="cursor-pointer">{shortOrderStatus(product)}</summary><p role="status" className="mt-2">{orderCheckMessage(product)}</p></details>
                    </div>
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
                      onClick={() => handleResetProductToOriginal(product.editorKey)}
                    >
                      ↺ 解析結果に戻す
                    </Button>
                  </div>

                  {product.order_mode === "pattern" ? <details id={repeatDetailsId} aria-label={`${product.product_code} のリピート詳細設定`} className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/30 p-3 dark:border-indigo-900/30 dark:bg-indigo-900/10">
                    <summary data-workspace-navigation className="min-h-11 cursor-pointer text-sm font-semibold" aria-label={`${product.product_code} の詳細設定・確認`}>詳細設定・確認</summary>
                    <div className="mt-3 space-y-3">
                    <div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <label className="text-xs">寸法の前提
                        <select aria-label={`${product.product_code} の寸法区分`} className="mt-1 block w-full rounded border bg-background p-2" value={product.measurement_basis} onChange={event => setOverrides(previous => ({ ...previous, [product.editorKey]: { ...previous[product.editorKey], quantityConfirmation: "", readingReviewConfirmation: "", measurementBasis: event.target.value as MemoProductItem["measurement_basis"] } }))}>
                          <option value="unconfirmed">未確認</option><option value="trim-included">切り代込みの裁断長</option><option value="repeat-adjusted">既に柄調整済み（再計算しない）</option>
                        </select>
                      </label>
                      <label className="text-xs">柄合わせ方式
                        <select aria-label={`${product.product_code} の柄合わせ方式`} className="mt-1 block w-full rounded border bg-background p-2" value={product.pattern_match} onChange={event => setOverrides(previous => ({ ...previous, [product.editorKey]: { ...previous[product.editorKey], quantityConfirmation: "", readingReviewConfirmation: "", patternMatch: event.target.value as MemoProductItem["pattern_match"] } }))}>
                          <option value="unconfirmed">未確認</option><option value="straight">ストレートリピート</option><option value="other">半落ち・その他（職人さんに確認）</option>
                        </select>
                      </label>
                    </div>
                    {!basicView ? <>
                    <p className="mb-2 text-xs" aria-label={`${product.product_code} の無地と柄比較`}>
                      計算前 {product.comparison.strict.totals.originalM === null ? "要確認" : `${product.comparison.strict.totals.originalM}m`} ／ 無地（切り代込み） {product.comparison.strict.totals.plainM === null ? "要確認" : `${product.comparison.strict.totals.plainM}m`} ／ 柄合わせ {product.comparison.strict.totals.patternM === null ? "要確認" : `${product.comparison.strict.totals.patternM}m`}
                    </p>
                    {!product.comparison.premisesAvailable ? <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">参考値です。寸法区分・柄合わせ・リピート値と写真の読み取りを確認してください。柄調整済み・半落ち等は推測計算しません。</p> : null}
                    </> : null}
                    </div>
                  </details> : null}

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
                         const rawQty = overrides[product.editorKey]?.entryQtys?.[eidx];
                         const rawLen = overrides[product.editorKey]?.entryLengths?.[eidx];
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
                                    onClick={() => handleToggleEntryRepeat(product.editorKey, eidx)}
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
                                      if (!ev.currentTarget.contains(ev.relatedTarget) && !navigationBlur(ev.relatedTarget) && !blurIntentRef.current.row && !(ev.relatedTarget instanceof Element && ev.relatedTarget.closest("[data-preserve-editor-input]"))) {
                                        setOverrides((prev) => {
                                          const po = prev[product.editorKey];
                                          if (!po || !po.entryEditMode || !po.entryEditMode[eidx]) return prev;
                                          return { ...prev, [product.editorKey]: { ...po, entryEditMode: { ...po.entryEditMode, [eidx]: false } } };
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
                                          onChange={(input) => handleEntryFieldChange(product.editorKey, eidx, "entryLengths", input.target.value)}
                                        />
                                        <span className="shrink-0 text-[11px] sm:text-sm">m</span>
                                        <span className="mx-0.5 shrink-0 text-[11px] text-muted-foreground sm:text-sm">×</span>
                                        <Input
                                          type="number" min="0"
                                          className="h-8 w-[3.25rem] border-indigo-300 px-1 text-center text-xs font-bold tabular-nums shadow-inner focus-visible:ring-indigo-500 dark:border-indigo-700 sm:w-[4rem] sm:text-sm"
                                          aria-label={`${product.product_code} ${eidx + 1}行目の幅数`}
                                          value={qValue}
                                          onChange={(input) => handleEntryFieldChange(product.editorKey, eidx, "entryQtys", input.target.value)}
                                        />
                                        <button
                                          type="button"
                                          onClick={() => handleResetEntry(product.editorKey, eidx)}
                                          className="ml-0.5 shrink-0 rounded-md p-1.5 text-rose-500/80 transition-colors hover:bg-black/10 hover:text-rose-500 dark:hover:bg-white/10"
                                          title="この行の編集を元に戻す"
                                        >
                                          <Undo2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => handleToggleEntryEdit(product.editorKey, eidx)}
                                        className="group/formula flex min-w-0 flex-1 items-center gap-0.5 rounded-md px-0.5 py-0.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5 sm:max-w-[12rem] sm:gap-1.5 sm:px-1 sm:py-1"
                                        title="タップして式を編集"
                                      >
                                        <span className={`min-w-0 shrink-0 truncate tabular-nums ${typeof rawLen === "number" && rawLen !== e.length_m ? "font-bold text-indigo-600 dark:text-indigo-400" : ""}`}>
                                          {e.length_input !== undefined ? "未入力" : <>{e.base_length !== e.derived_length ? <span className="mr-0.5 text-[10px] font-normal text-muted-foreground">{e.base_length}→</span> : null}{e.derived_length}m</>}
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
                                    onClick={() => handleDeleteEntry(product.editorKey, eidx)}
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
                            value={newEntryInputs[product.editorKey]?.length ?? ""}
                            onChange={(e) => handleNewEntryChange(product.editorKey, "length", e.target.value)}
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
                            value={newEntryInputs[product.editorKey]?.quantity ?? ""}
                            onChange={(e) => handleNewEntryChange(product.editorKey, "quantity", e.target.value)}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 shrink-0 gap-1.5 rounded-lg border-indigo-300 bg-white px-3 text-xs font-bold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:bg-black dark:text-indigo-200 dark:hover:bg-indigo-950"
                          onClick={() => handleAddEntry(product.editorKey)}
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
      <CopyReviewDialog key={copyReviewSession} open={copyReviewOpen} rows={copyReviewOpen ? copyReviewRows : []} batchToken={copyBatchToken} siteName={siteName}
        copyReady={copyReviewRows.length > 0 && copyReviewRows.every(row => row.ready)} onClose={() => closeCopyReview()}
        onApply={applyCopyReview} onCopy={copyOrderText}
        onEdit={id => { const row = liveCopyReview.current.rows.find(row => row.id === id); if (row) closeCopyReview(() => {
          setCollapsedCodes(current => { const next = new Set(current); next.delete(row.editorKey); return next; }); selectView("edit", row.editorKey);
        }); }}
        onPhoto={index => { setPhotoError(false); setPhotoIndex(index); if (copyPhotoRef.current) { copyPhotoRef.current.open = true; copyPhotoRef.current.scrollIntoView({ block: "start" }); } }}
        photo={copyReviewOpen ? <details ref={copyPhotoRef} open className="space-y-2 rounded-xl border p-3"><summary className="min-h-11 cursor-pointer font-semibold">メモ画像（この結果）</summary>{sourcePhoto(true)}</details> : null} />
      <div role="tablist" data-workspace-navigation aria-label="解析結果の表示" hidden={keyboardOpen} className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-5xl grid-cols-3 gap-1 border-t bg-background px-2 pt-2 shadow-lg print:hidden" style={{ display: keyboardOpen ? "none" : undefined, paddingBottom: "calc(.5rem + env(safe-area-inset-bottom))" }} onKeyDown={event => {
        const index = views.findIndex(view => view.value === resultView);
        const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); selectView(views[next].value); window.requestAnimationFrame(() => document.getElementById(`${navId}-${views[next].value}-tab`)?.focus());
      }}>
        {views.map(({ value, label }) => <button key={value} id={`${navId}-${value}-tab`} role="tab" type="button" aria-selected={resultView === value} aria-controls={`${navId}-${value}`} tabIndex={resultView === value ? 0 : -1} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs font-bold focus-visible:ring-2 focus-visible:ring-indigo-500 ${resultView === value ? "bg-indigo-950 text-white" : "text-muted-foreground"}`} onClick={() => selectView(value)}>
          {value === "quantity" ? <Layers aria-hidden="true" focusable="false" className="h-5 w-5" /> : value === "edit" ? <Edit3 aria-hidden="true" focusable="false" className="h-5 w-5" /> : <ImageIcon aria-hidden="true" focusable="false" className="h-5 w-5" />}{label}
        </button>)}
      </div>
    </div>
  );
}
