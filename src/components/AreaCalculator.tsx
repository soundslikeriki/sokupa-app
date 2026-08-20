"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  ChevronDown,
  ChevronUp,
  Globe,
  Loader2,
  Minus,
  Plus,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  calculateAreaRequirement,
  extractWallpaperWidthCm,
  normalizeWallpaperProductCode,
  STANDARD_WALLPAPER_WIDTH_CM,
  WIDE_WALLPAPER_WIDTH_CM,
} from "@/lib/area-calculation";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";

type WidthMode = "standard" | "wide" | "custom" | "catalog";

type WallpaperLookupData = {
  product_code: string;
  found: boolean;
  manufacturer?: string;
  spec?: string;
  repeat_info?: { from_product?: string };
  notes?: string;
  source_url?: string;
  catalog_name?: string;
  catalog_page_num?: string;
  is_live_searched?: boolean;
};

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString("ja-JP", { maximumFractionDigits });
}

function hasMeaningfulText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.trim() !== "不明";
}

export function AreaCalculator() {
  const [areaInput, setAreaInput] = useState("");
  const [productCode, setProductCode] = useState("");
  const [widthMode, setWidthMode] = useState<WidthMode>("standard");
  const [customWidthInput, setCustomWidthInput] = useState("");
  const [catalogWidthCm, setCatalogWidthCm] = useState<number | null>(null);
  const [lossPercent, setLossPercent] = useState(DEFAULT_LOSS_RATE_PERCENT);
  const [lookupData, setLookupData] = useState<WallpaperLookupData | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [widthNotice, setWidthNotice] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [productDetailsOpen, setProductDetailsOpen] = useState(false);
  const lookupCacheRef = useRef<Map<string, WallpaperLookupData>>(new Map());

  const widthCm = useMemo(() => {
    if (widthMode === "wide") return WIDE_WALLPAPER_WIDTH_CM;
    if (widthMode === "catalog") return catalogWidthCm ?? STANDARD_WALLPAPER_WIDTH_CM;
    if (widthMode === "custom") {
      const custom = Number(customWidthInput);
      return Number.isFinite(custom) && custom > 0 ? custom : Number.NaN;
    }
    return STANDARD_WALLPAPER_WIDTH_CM;
  }, [catalogWidthCm, customWidthInput, widthMode]);

  const calculation = useMemo(
    () => calculateAreaRequirement(Number(areaInput), widthCm / 100, lossPercent),
    [areaInput, lossPercent, widthCm],
  );

  const applyLookupData = (data: WallpaperLookupData) => {
    setLookupData(data);
    setProductDetailsOpen(data.found);
    setLookupError(null);

    const detectedWidth = extractWallpaperWidthCm(data.spec);
    if (detectedWidth) {
      setCatalogWidthCm(detectedWidth);
      setWidthMode("catalog");
      setWidthNotice(`商品情報の有効巾 ${formatNumber(detectedWidth)}cm を計算に反映しました。`);
      return;
    }

    setCatalogWidthCm(null);
    setWidthMode("standard");
    setWidthNotice("有効巾を取得できなかったため、標準92cmで計算しています。");
  };

  const handleProductCodeChange = (value: string) => {
    setProductCode(value);
    const normalized = normalizeWallpaperProductCode(value);
    if (lookupData && lookupData.product_code !== normalized) {
      setLookupData(null);
      setLookupError(null);
      setWidthNotice(null);
      setCatalogWidthCm(null);
      if (widthMode === "catalog") setWidthMode("standard");
    }
  };

  const handleLookup = async () => {
    const normalized = normalizeWallpaperProductCode(productCode);
    if (!normalized || isLookingUp) return;

    const cached = lookupCacheRef.current.get(normalized);
    if (cached) {
      applyLookupData(cached);
      return;
    }

    setIsLookingUp(true);
    setLookupError(null);
    try {
      const response = await fetch("/api/wallpaper-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_code: normalized }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        data?: WallpaperLookupData;
        error?: string;
      };
      if (!response.ok || !json.data) {
        throw new Error(json.error || `商品情報の取得に失敗しました（HTTP ${response.status}）`);
      }

      lookupCacheRef.current.set(normalized, json.data);
      applyLookupData(json.data);
    } catch (error) {
      setLookupData(null);
      setCatalogWidthCm(null);
      setWidthMode("standard");
      setWidthNotice("有効巾を取得できなかったため、標準92cmで計算しています。");
      setLookupError(error instanceof Error ? error.message : "商品情報の取得に失敗しました。");
    } finally {
      setIsLookingUp(false);
    }
  };

  const repeatText = lookupData?.repeat_info?.from_product?.trim() || "";

  return (
    <Card className="border-none bg-white/75 shadow-xl ring-1 ring-inset ring-emerald-500/20 backdrop-blur-xl dark:bg-zinc-900/75">
      <CardHeader className="border-b border-black/5 px-3 py-4 dark:border-white/5 sm:px-6 sm:py-5">
        <CardTitle className="flex items-center gap-2 text-lg font-bold sm:text-xl">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
            <Calculator className="h-5 w-5" />
          </span>
          ㎡から必要m数を計算
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-5 px-3 py-4 sm:px-6 sm:py-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="area-sqm" className="mb-1.5 block text-sm font-bold">
              施工面積
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-2">
              <Input
                id="area-sqm"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={areaInput}
                onChange={(event) => setAreaInput(event.target.value)}
                className="h-12 bg-white text-lg font-bold tabular-nums dark:bg-black"
                placeholder="178"
              />
              <span className="text-sm font-bold text-muted-foreground">㎡</span>
            </div>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleLookup();
            }}
          >
            <label htmlFor="area-product-code" className="mb-1.5 block text-sm font-bold">
              品番 <span className="font-normal text-muted-foreground">（任意）</span>
            </label>
            <div className="flex gap-2">
              <Input
                id="area-product-code"
                value={productCode}
                onChange={(event) => handleProductCodeChange(event.target.value)}
                className="h-12 min-w-0 bg-white font-bold uppercase tabular-nums dark:bg-black"
                placeholder="例: TH32661"
                autoCapitalize="characters"
              />
              <Button
                type="submit"
                variant="outline"
                className="h-12 shrink-0 gap-1.5 bg-white px-3 text-xs font-bold dark:bg-black sm:text-sm"
                disabled={!normalizeWallpaperProductCode(productCode) || isLookingUp}
              >
                {isLookingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="hidden sm:inline">品番情報を取得</span>
                <span className="sm:hidden">検索</span>
              </Button>
            </div>
          </form>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wallpaper-width-mode" className="mb-1.5 block text-sm font-bold">
              有効巾
            </label>
            <select
              id="wallpaper-width-mode"
              value={widthMode}
              onChange={(event) => setWidthMode(event.target.value as WidthMode)}
              className="h-12 w-full rounded-md border border-input bg-white px-3 text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-ring dark:bg-black"
            >
              <option value="standard">標準クロス：92cm</option>
              <option value="wide">広幅クロス：100cm</option>
              {catalogWidthCm ? <option value="catalog">品番情報：{formatNumber(catalogWidthCm)}cm</option> : null}
              <option value="custom">その他：任意入力</option>
            </select>
            {widthMode === "custom" ? (
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={customWidthInput}
                  onChange={(event) => setCustomWidthInput(event.target.value)}
                  className="h-11 bg-white font-bold tabular-nums dark:bg-black"
                  placeholder="92.5"
                  aria-label="任意の有効巾"
                />
                <span className="text-sm font-bold text-muted-foreground">cm</span>
              </div>
            ) : null}
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-bold">ロス率</span>
            <div className="grid grid-cols-[2.75rem_minmax(4rem,1fr)_1.5rem_2.75rem] items-center gap-2 rounded-lg border border-black/5 bg-black/[0.03] p-1.5 dark:border-white/5 dark:bg-white/[0.04]">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 bg-white dark:bg-black"
                onClick={() => setLossPercent((current) => Math.max(0, current - 1))}
                disabled={lossPercent <= 0}
                aria-label="ロス率を1%減らす"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                min="0"
                step="1"
                value={lossPercent}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setLossPercent(Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
                }}
                className="h-11 bg-white text-center text-lg font-bold tabular-nums dark:bg-black"
                aria-label="ロス率"
              />
              <span className="text-center text-sm font-bold text-muted-foreground">%</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 bg-white dark:bg-black"
                onClick={() => setLossPercent((current) => current + 1)}
                aria-label="ロス率を1%増やす"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {[5, 10, 15, 20].map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant={lossPercent === preset ? "default" : "outline"}
                  className="h-9 px-2 text-xs font-bold"
                  onClick={() => setLossPercent(preset)}
                >
                  {preset}%
                </Button>
              ))}
            </div>
          </div>
        </div>

        {widthNotice ? (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-200">
            {widthNotice}
          </p>
        ) : null}
        {lookupError ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-900 dark:text-rose-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{lookupError} 計算は入力中の有効巾で続けられます。</span>
          </div>
        ) : null}

        {calculation ? (
          <div className="overflow-hidden rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06]">
            <div className="flex items-end justify-between gap-3 border-b border-emerald-500/15 px-4 py-4 sm:px-5">
              <div>
                <p className="text-xs font-bold text-emerald-900/60 dark:text-emerald-100/60">推奨発注量</p>
                <p className="mt-1 text-4xl font-black tabular-nums tracking-tight text-emerald-700 dark:text-emerald-300 sm:text-5xl">
                  {formatNumber(calculation.recommendedMeters, 0)}<span className="ml-1 text-xl">m</span>
                </p>
              </div>
              <Badge className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-600">ロス {lossPercent}%</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-xs sm:grid-cols-3 sm:px-5 sm:text-sm">
              <div><dt className="text-muted-foreground">施工面積</dt><dd className="mt-0.5 font-bold tabular-nums">{formatNumber(calculation.areaSqm)}㎡</dd></div>
              <div><dt className="text-muted-foreground">使用した有効巾</dt><dd className="mt-0.5 font-bold tabular-nums">{formatNumber(widthCm)}cm</dd></div>
              <div><dt className="text-muted-foreground">基準必要m</dt><dd className="mt-0.5 font-bold tabular-nums">{formatNumber(calculation.baseMeters)}m</dd></div>
              <div><dt className="text-muted-foreground">ロス率</dt><dd className="mt-0.5 font-bold tabular-nums">{formatNumber(calculation.lossPercent, 0)}%</dd></div>
              <div><dt className="text-muted-foreground">ロス込み必要m</dt><dd className="mt-0.5 font-bold tabular-nums">{formatNumber(calculation.metersWithLoss)}m</dd></div>
              <div><dt className="text-muted-foreground">推奨発注m</dt><dd className="mt-0.5 font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{formatNumber(calculation.recommendedMeters, 0)}m</dd></div>
            </dl>
          </div>
        ) : null}

        {lookupData ? (
          <div className="rounded-lg border border-black/5 bg-black/[0.025] dark:border-white/5 dark:bg-white/[0.035]">
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-bold"
              onClick={() => setProductDetailsOpen((current) => !current)}
              aria-expanded={productDetailsOpen}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Globe className="h-4 w-4 shrink-0 text-cyan-600" />
                <span className="truncate">商品情報：{lookupData.product_code}</span>
              </span>
              {productDetailsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {productDetailsOpen ? (
              <div className="grid gap-3 border-t border-black/5 px-3 py-3 text-xs dark:border-white/5 sm:grid-cols-2 sm:text-sm">
                <div><span className="text-muted-foreground">メーカー</span><p className="mt-0.5 font-semibold">{lookupData.manufacturer || "情報なし"}</p></div>
                <div><span className="text-muted-foreground">規格・有効巾</span><p className="mt-0.5 font-semibold">{lookupData.spec || "情報なし"}</p></div>
                <div><span className="text-muted-foreground">リピート</span><p className="mt-0.5 font-semibold">{repeatText || "情報なし"}</p></div>
                <div><span className="text-muted-foreground">カタログ</span><p className="mt-0.5 font-semibold">{lookupData.catalog_name || "情報なし"}{lookupData.catalog_page_num ? ` P.${lookupData.catalog_page_num}` : ""}</p></div>
                {lookupData.notes ? <div className="sm:col-span-2"><span className="text-muted-foreground">備考</span><p className="mt-0.5 font-semibold leading-relaxed">{lookupData.notes}</p></div> : null}
                {hasMeaningfulText(repeatText) ? (
                  <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300 sm:col-span-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    柄合わせやリピートにより追加ロスが必要な場合があります。
                  </p>
                ) : null}
                {lookupData.source_url ? (
                  <a href={lookupData.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-cyan-700 hover:underline dark:text-cyan-300 sm:col-span-2">
                    <Globe className="h-4 w-4" />
                    情報元を開く
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
