"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyIcon, CheckCircle2, AlertTriangle, Layers, Edit3, RefreshCw, Undo2, Globe } from "lucide-react";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import type { MemoProductItem } from "@/types";

const MFG_ORDER = ["サンゲツ", "リリカラ", "トキワ", "シンコール", "東リ", "不明", "その他"] as const;

function groupLabel(manufacturer: string): (typeof MFG_ORDER)[number] {
  const m = manufacturer.trim();
  const u = m.toUpperCase();
  if (m.includes("東リ") || u.includes("TOLI")) return "東リ";
  if (m.includes("不明")) return "不明";
  for (const label of ["サンゲツ", "リリカラ", "トキワ", "シンコール"] as const) {
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

function buildOrderRequestText(items: any[], siteName: string, lossRatePercent: number): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("ja-JP", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });

  let text = `作成型：${APP_FORMAL_NAME}（${APP_PRODUCT_NAME}）\n`;
  text += `現場名：${siteName.trim() || "未入力"}\n`;
  text += `日時：${dateStr}\n\n`;
  text += `【発注リスト】\n`;

  for (const item of items) {
    text += `・品番：${item.product_code} / 数量：${item.order_quantity}m\n`;
  }

  text += `\n【計算根拠】発注数量は実測に${DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げています（※ロス率変更可能）。`;
  text += `この書出し時のロス率：${lossRatePercent}%。`;

  return text.trim();
}

type OrderListProps = {
  items: MemoProductItem[];
  notes?: string;
  siteName?: string;
  needs_review_any?: boolean;
};

type ItemOverride = {
  repeatCm?: number | "";
  heightM?: number | "";
  entryQtys?: Record<number, number | "">;
  entryLengths?: Record<number, number | "">;
  entryEditMode?: Record<number, boolean>;
  entryRepeatActive?: Record<number, boolean>;
};

export function OrderList({ items, notes, siteName = "", needs_review_any }: OrderListProps) {
  const [lossRate, setLossRate] = useState(DEFAULT_LOSS_RATE_PERCENT);
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});

  const handleOverrideChange = (productCode: string, field: keyof Omit<ItemOverride, "entryQtys" | "entryEditMode" | "entryRepeatActive" | "entryLengths">, value: string) => {
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

  const handleToggleEntryRepeat = (productCode: string, entryIndex: number) => {
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

  const handleResetProduct = (productCode: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[productCode];
      return next;
    });
  };

  const derivedItems = useMemo(() => {
    return items.map((item) => {
      const ovr = overrides[item.product_code] || {};
      const eqtys = ovr.entryQtys || {};
      const elengths = ovr.entryLengths || {};
      const eRepeats = ovr.entryRepeatActive || {};
      
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

      const order_quantity = Math.ceil(calcTotalM * (1 + lossRate / 100));

      return {
        ...item,
        total_m: Number(calcTotalM.toFixed(2)),
        order_quantity,
        override_active,
        rActive: masterRepeatStatus,
        total_quantity: calcTotalQty,
        derivedEntries
      };
    });
  }, [items, overrides, lossRate]);

  const groups = useMemo(() => groupByManufacturer(derivedItems), [derivedItems]);

  const copyOrderText = async () => {
    if (!derivedItems.length) return;
    const text = buildOrderRequestText(derivedItems, siteName, lossRate);
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
          発注数量は実測に{DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げています（※ロス率変更可能）。印刷時のロス率:{" "}
          {lossRate}%
        </p>
      </div>
      <Card className="border-none shadow-xl bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent backdrop-blur-xl ring-1 ring-inset ring-indigo-500/20">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 shadow-lg text-white">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-900 to-purple-900 dark:from-indigo-100 dark:to-purple-100">
                  発注リスト
                </CardTitle>
                <CardDescription className="text-sm mt-1 font-medium text-indigo-900/60 dark:text-indigo-100/60">
                  {APP_FORMAL_NAME} — AIの計測にロス率を加算、または手動でリピート計算を行います
                </CardDescription>
              </div>
            </div>
            
            <div className="flex items-center gap-2 bg-white/60 dark:bg-black/60 p-1.5 rounded-xl border border-indigo-500/10 shadow-sm">
              <span className="text-sm font-bold opacity-70 ml-2">ロス率</span>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setLossRate(Math.max(0, lossRate - 1))}>-</Button>
              <div className="w-10 text-center font-black tabular-nums">{lossRate}%</div>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setLossRate(lossRate + 1)}>+</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-indigo-900/85 dark:text-indigo-100/85 max-w-3xl leading-relaxed">
            発注数量は実測に{DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げています
            <span className="text-xs text-muted-foreground">（※ロス率変更可能）</span>。
          </p>
          {needs_review_any && (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 shadow-inner">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                黄色のバッジがついている推測結果は必ず現場メモ・見本帳と一致しているかご確認ください。
              </p>
            </div>
          )}
          <Button 
            onClick={() => void copyOrderText()} 
            className="w-full text-base font-semibold py-6 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
          >
            <CopyIcon className="w-4 h-4 mr-2" />
            発注用テキストをコピー
          </Button>
          {notes && (
            <div className="p-4 rounded-xl bg-white/50 dark:bg-black/20 text-sm font-medium border border-black/5 dark:border-white/5">
              <span className="opacity-70">メモ備考:</span> {notes}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-6">
        {groups.map((group) => (
          <Card key={group.label} className="border-none shadow-md overflow-hidden bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md">
            <CardHeader className="bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/5 px-6 py-4 flex flex-row items-center justify-between">
              <CardTitle className="text-lg font-bold tracking-tight">{group.label}</CardTitle>
              <Badge variant="secondary" className="px-3 py-1 font-bold rounded-full bg-white dark:bg-black text-xs shadow-sm">
                {group.rows.length} 品番
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {group.rows.map((product, idx) => (
                <div key={product.product_code} className={`p-6 ${idx !== 0 ? "border-t border-black/5 dark:border-white/5" : ""} hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors`}>
                  <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                    <div className="flex items-center gap-2">
                      <h4 className="text-xl font-extrabold tracking-tight">
                        {product.product_code}
                      </h4>
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
                    <div className="flex items-baseline gap-2 bg-black/5 dark:bg-white/5 px-4 py-2 rounded-xl border border-black/5">
                      <span className="text-xs font-medium opacity-60">発注数量</span>
                      <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400 tabular-nums leading-none">
                        {product.order_quantity}
                      </span>
                      <span className="font-semibold opacity-60">m</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                    <div className="bg-white/60 dark:bg-black/40 rounded-xl p-3 border border-black/5 dark:border-white/5">
                      <span className="block text-[10px] font-bold uppercase tracking-wider opacity-50 mb-1">規格・寸法</span>
                      <span className="font-medium text-sm">{product.spec?.trim() || "情報なし"}</span>
                    </div>
                    <div className="bg-white/60 dark:bg-black/40 rounded-xl p-3 border border-black/5 dark:border-white/5">
                      <span className="block text-[10px] font-bold uppercase tracking-wider opacity-50 mb-1">リピート</span>
                      <span className="font-medium text-sm">{product.repeat_info?.from_product?.trim() || "情報なし"}</span>
                    </div>
                    {product.notes?.trim() && (
                      <div className="md:col-span-2 bg-white/60 dark:bg-black/40 rounded-xl p-3 border border-black/5 dark:border-white/5 text-sm text-muted-foreground font-medium">
                        <span className="mr-2 opacity-60">備考:</span>{product.notes.trim()}
                      </div>
                    )}
                  </div>

                  <div className="bg-indigo-50/50 dark:bg-indigo-900/10 rounded-xl p-4 mt-3 mb-6 border border-indigo-100 dark:border-indigo-900/30 shadow-sm transition-colors">
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
                    
                    <div className={`flex items-center gap-4 transition-opacity duration-300 ${(product.derivedEntries || []).some((e: any) => e.isRepeatActive) ? 'opacity-100' : 'opacity-40'}`}>
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

                  <div className="bg-black/5 dark:bg-white/5 rounded-xl p-4 relative overflow-hidden group/memo">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleResetProduct(product.product_code)}
                      className="absolute top-2 right-2 h-[26px] px-2.5 text-[10px] items-center gap-1.5 opacity-0 group-hover/memo:opacity-100 transition-opacity bg-white hover:bg-gray-100 dark:bg-black dark:hover:bg-zinc-900 border-black/10 shadow-sm"
                    >
                      <RefreshCw className="w-3 h-3 text-indigo-600" />
                      AI初期値にもどす
                    </Button>
                    <div className="flex flex-wrap items-center mb-4 pr-32">
                      <span className="text-xs font-bold uppercase tracking-wider opacity-60 flex items-center gap-1.5">
                        計測メモ
                      </span>
                    </div>
                    <div className="space-y-2">
                       {product.derivedEntries?.map((e: any, eidx: number) => {
                         const rawQty = overrides[product.product_code]?.entryQtys?.[eidx];
                         const rawLen = overrides[product.product_code]?.entryLengths?.[eidx];
                         const qValue = rawQty !== undefined ? rawQty : e.quantity;
                         const lValue = rawLen !== undefined ? rawLen : e.length_m;
                         
                         return (
                           <div key={eidx} className="flex justify-between text-sm font-medium items-center py-2 px-3 rounded-lg bg-white/50 dark:bg-black/50 border border-black/5 dark:border-white/5 gap-2 group/row transition-colors hover:bg-white/80 dark:hover:bg-black/80">
                             <div className="flex items-center gap-2 flex-1 min-w-0">
                                <button 
                                  onClick={() => handleToggleEntryRepeat(product.product_code, eidx)}
                                  className={`shrink-0 w-6 h-3.5 flex items-center rounded-full p-[2px] transition-colors ${e.isRepeatActive ? 'bg-indigo-600' : 'bg-black/20 dark:bg-white/20'}`}
                                  title="この行にリピート計算を適用する"
                                >
                                  <div className={`bg-white w-2.5 h-2.5 rounded-full shadow-sm transform transition-transform ${e.isRepeatActive ? 'translate-x-[10px]' : ''}`} />
                                </button>
                                <button 
                                  onClick={() => handleToggleEntryEdit(product.product_code, eidx)}
                                  className={`shrink-0 p-1 rounded transition-all ${e.isEditing ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50' : 'hover:bg-black/10 dark:hover:bg-white/10 opacity-30 hover:opacity-100'}`}
                                  title="この行を直接編集する"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <span className={`opacity-70 truncate ${e.isRepeatActive ? "text-indigo-700 dark:text-indigo-300 font-bold" : ""}`} title={e.original_formula}>{e.original_formula || "—"}</span>
                             </div>

                             <div className="flex items-center justify-end gap-1.5 opacity-80 pl-2">
                                {e.isEditing ? (
                                  <>
                                    <Input 
                                      type="number" 
                                      step="0.1" 
                                      className="w-[60px] h-7 text-xs px-1 text-center tabular-nums font-bold border-indigo-300 dark:border-indigo-700 focus-visible:ring-indigo-500 shadow-inner"
                                      value={lValue}
                                      onChange={(input) => handleEntryFieldChange(product.product_code, eidx, "entryLengths", input.target.value)}
                                    />
                                    <span>m</span>
                                    <span className="mx-0.5">×</span>
                                    <Input 
                                      type="number" 
                                      className="w-[45px] h-7 text-xs px-1 text-center tabular-nums font-bold border-indigo-300 dark:border-indigo-700 focus-visible:ring-indigo-500 shadow-inner"
                                      value={qValue}
                                      onChange={(input) => handleEntryFieldChange(product.product_code, eidx, "entryQtys", input.target.value)}
                                    />
                                    <button
                                      onClick={() => handleResetEntry(product.product_code, eidx)}
                                      className="ml-1 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-rose-500/70 hover:text-rose-500 transition-colors shrink-0"
                                      title="この行の編集を元に戻す"
                                    >
                                      <Undo2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <span className={`tabular-nums whitespace-nowrap ${typeof rawLen === "number" && rawLen !== e.length_m ? "text-indigo-600 dark:text-indigo-400 font-bold" : ""}`}>
                                      {e.derived_length}m
                                    </span>
                                    <span className="mx-0.5">×</span>
                                    <span className={`w-[45px] text-center tabular-nums font-bold ${typeof rawQty === "number" && rawQty !== e.quantity ? "text-indigo-600 dark:text-indigo-400" : ""}`}>
                                      {qValue}
                                    </span>
                                  </>
                                )}
                             </div>
                             <span className="w-16 text-right tabular-nums text-indigo-600 dark:text-indigo-400 font-bold shrink-0">
                               {e.derived_subtotal}m
                             </span>
                           </div>
                         );
                       })}
                    </div>
                    <div className="flex justify-between items-center mt-3 pt-3 border-t border-black/10 dark:border-white/10 px-2">
                       <span className="text-xs font-bold opacity-60">全体ロス {lossRate}%</span>
                       <span className="text-xs font-bold tabular-nums">
                         <span className="opacity-60 mr-1">計測合計:</span>
                         <span className={product.override_active ? "text-indigo-600 dark:text-indigo-400" : "opacity-80"}>{product.total_m}m</span>
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
