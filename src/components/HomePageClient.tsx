"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";

import { OrderList } from "@/components/OrderList";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import { convertAndResizeForPreview } from "@/lib/resizeImage";
import { supabase } from "@/lib/supabase";
type ProcessedImage = {
  id: string;
  originalName: string;
  previewUrl: string;
  base64Data?: string;
  status: "converting" | "ready" | "error";
};
import { cn } from "@/lib/utils";
import type { ParsedMemoPayload } from "@/types";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
}

export default function HomePageClient() {
  const uploadInputId = useId();
  const siteNameId = useId();
  const [siteName, setSiteName] = useState("");
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [parsed, setParsed] = useState<ParsedMemoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobAccepted, setJobAccepted] = useState<{ jobId: string } | null>(null);
  const [jobUi, setJobUi] = useState<{
    status: "queued" | "running" | "done" | "failed";
    done: number;
    total: number;
    percent: number;
  } | null>(null);

  const readyImages = useMemo(
    () => images.filter((img) => img.status === "ready" && img.base64Data),
    [images],
  );

  // LINEログイン情報（通知先）
  useEffect(() => {
    try {
      const lid = localStorage.getItem("sokupa:line_user_id") || getCookie("sokupa_line_user_id") || "";
      setLineUserId(lid && lid.trim() ? lid : null);
    } catch {
      setLineUserId(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const buildOrderTextForCopy = useCallback((): string => {
    const lines: string[] = [];
    const site = siteName?.trim() || "";
    lines.push(`現場名：${site || "未入力"}`);
    lines.push(
      `日時：${new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`,
    );
    lines.push("");
    lines.push("【発注リスト】");

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (items.length === 0) {
      lines.push("（品番なし）");
    } else {
      for (const item of items) {
        const code = String((item as any)?.product_code ?? "").trim() || "不明";
        const orderQty = Number((item as any)?.order_quantity);
        const totalM = Number((item as any)?.total_m);
        const qty =
          Number.isFinite(orderQty) && orderQty > 0
            ? `${orderQty}m`
            : Number.isFinite(totalM) && totalM > 0
              ? `${totalM}m`
              : "数量不明";
        lines.push(`・品番：${code} / 数量：${qty}`);
      }
    }

    return lines.join("\n");
  }, [parsed?.items, siteName]);

  const handleCopyOrderText = useCallback(async () => {
    const text = buildOrderTextForCopy();
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2000);
    } catch (e) {
      console.error("クリップボードコピー失敗", e);
      try {
        alert("コピーに失敗しました（クリップボードの権限をご確認ください）");
      } catch {
        // ignore
      }
    }
  }, [buildOrderTextForCopy]);

  function mergeParsed(prev: ParsedMemoPayload | null, next: ParsedMemoPayload): ParsedMemoPayload {
    const prevItems = prev?.items ?? [];
    const map = new Map<string, ParsedMemoPayload["items"][number]>();
    for (const it of prevItems) map.set(it.product_code, it);
    for (const it of next.items) {
      const existing = map.get(it.product_code);
      if (!existing) {
        map.set(it.product_code, it);
        continue;
      }
      const mergedEntries = [...(existing.entries ?? []), ...(it.entries ?? [])];
      const totalFromEntries = mergedEntries.reduce((s, e) => s + (Number(e.subtotal_m) || 0), 0);
      const merged: typeof it = {
        ...existing,
        ...it,
        entries: mergedEntries,
        total_m: Number.isFinite(it.total_m) && it.total_m > 0 ? it.total_m : totalFromEntries,
        order_quantity: it.order_quantity ?? existing.order_quantity,
      };
      map.set(it.product_code, merged);
    }
    const items = Array.from(map.values());
    const needs_review_any = items.some((i) => i.needs_review);
    return {
      items,
      notes: [prev?.notes, next.notes].filter(Boolean).join("\n").trim() || undefined,
      needs_review_any,
    };
  }

  function deriveContextFromParsed(p: ParsedMemoPayload | null): { majorManufacturers: string[]; knownProductCodes: string[] } {
    const items = p?.items ?? [];
    const codes = items.map((i) => i.product_code).filter(Boolean);
    const mfgs = items.map((i) => i.manufacturer).filter(Boolean);
    const mfgCounts = new Map<string, number>();
    for (const m of mfgs) mfgCounts.set(m, (mfgCounts.get(m) ?? 0) + 1);
    const majorManufacturers = Array.from(mfgCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([m]) => m);
    return { majorManufacturers, knownProductCodes: codes.slice(0, 25) };
  }

  const imageCount = images.length;
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    const imageFiles = files.filter(
      (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name),
    );
    if (imageFiles.length === 0) return;

    // 画像は最大5枚まで
    if (imageCount + imageFiles.length > 5) {
      setError("画像は最大5枚までです。枚数を減らして再度お試しください。");
      return;
    }

    const newImages: ProcessedImage[] = imageFiles.map((file) => ({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      originalName: file.name,
      previewUrl: "",
      status: "converting" as const,
    }));

    setImages((prev) => [...prev, ...newImages]);
    setError(null);

    Promise.all(
      newImages.map(async (imgObj, idx) => {
        const file = imageFiles[idx];
        try {
          // Send 1500px max dimension image at 0.6 quality to aggressively reduce payload
          // Mobile HEIC/JPEG を AI が読み取りやすいサイズへ（長辺 2000px 目安）
          const dataUrl = await convertAndResizeForPreview(file, 2000, 0.72);
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id
                ? {
                    ...img,
                    previewUrl: dataUrl,
                    base64Data: dataUrl.replace(/^data:image\/jpeg;base64,/, ""),
                    status: "ready",
                  }
                : img
            )
          );
        } catch (err) {
          console.error("画像処理エラー", err);
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id ? { ...img, status: "error" } : img
            )
          );
        }
      })
    );
  }, [imageCount]);

  const removeFile = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleAnalyze = async () => {
    if (isAnalyzing) return;
    if (readyImages.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    setParsed(null);
    setProgress({ done: 0, total: readyImages.length });
    setJobAccepted(null);
    setJobUi(null);

    try {
      // 1) upload prepared JPEGs to Supabase Storage and obtain public URLs
      const uploadedUrls: string[] = [];
      for (let i = 0; i < readyImages.length; i++) {
        const img = readyImages[i]!;
        const base64 = img.base64Data as string;
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        const blob = new Blob([bytes], { type: "image/jpeg" });

        const path = `uploads/${Date.now()}_${img.id}.jpg`;
        const { error: upErr } = await supabase.storage.from("memo_uploads").upload(path, blob, {
          contentType: "image/jpeg",
          upsert: true,
        });
        if (upErr) throw new Error(`画像アップロードに失敗しました: ${upErr.message}`);
        const { data } = supabase.storage.from("memo_uploads").getPublicUrl(path);
        if (!data?.publicUrl) throw new Error("画像URLの生成に失敗しました");
        uploadedUrls.push(data.publicUrl);

        setProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + 1) } : null));
      }

      // 2) create a background analysis job on the server
      const createRes = await fetch("/api/analysis-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: uploadedUrls,
          site_name: siteName?.trim() || undefined,
          line_user_id: lineUserId || undefined,
          context: {
            site_name: siteName?.trim() || undefined,
            major_manufacturers: [],
            known_product_codes: [],
          },
        }),
      });
      const createJson = (await createRes.json()) as any;
      if (!createRes.ok || createJson?.error) {
        const msg = createJson?.error || `ジョブ作成に失敗しました（HTTP ${createRes.status}）`;
        try {
          alert(`解析ジョブの受付に失敗しました\n${msg}`);
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      setJobAccepted({ jobId: String(createJson.job_id) });
      try {
        localStorage.setItem("sokupa:lastJobId", String(createJson.job_id));
      } catch {
        // ignore
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析中にエラーが発生しました");
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
    }
  };

  // Restore last job on reload (so closing browser continues UX)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const last = localStorage.getItem("sokupa:lastJobId");
        if (!last) return;
        const { data, error } = await supabase
          .from("analysis_jobs")
          .select("status,result,error")
          .eq("id", last)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data) {
          localStorage.removeItem("sokupa:lastJobId");
          return;
        }
        if (data.status === "done" && data.result) {
          setParsed(data.result as ParsedMemoPayload);
          localStorage.removeItem("sokupa:lastJobId");
          return;
        }
        if (data.status === "failed") {
          try {
            alert(`前回の解析が失敗しています\n${String(data.error || "unknown")}`);
          } catch {
            // ignore
          }
          localStorage.removeItem("sokupa:lastJobId");
          return;
        }
        // queued/running: resume polling
        setJobAccepted({ jobId: last });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll job status every ~3s and auto-show results when done
  useEffect(() => {
    if (!jobAccepted?.jobId) return;
    let cancelled = false;

    const pollOnce = async () => {
      const { data, error: qErr } = await supabase
        .from("analysis_jobs")
        .select("status,done_images,total_images,result,error")
        .eq("id", jobAccepted.jobId)
        .maybeSingle();
      if (cancelled) return;
      if (qErr || !data) return;

      const status = (data.status as any) || "queued";
      const done = Number(data.done_images) || 0;
      const total = Math.max(1, Number(data.total_images) || 1);
      const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
      setJobUi({ status, done, total, percent });

      if (status === "failed") {
        const msg = String(data.error || "解析に失敗しました");
        try {
          alert(`解析に失敗しました\n${msg}`);
        } catch {
          // ignore
        }
        setError(msg);
        setJobAccepted(null);
        setJobUi(null);
        try {
          localStorage.removeItem("sokupa:lastJobId");
        } catch {
          // ignore
        }
      }

      if (status === "done") {
        if (data.result) {
          setParsed(data.result as ParsedMemoPayload);
          setJobAccepted(null);
          setJobUi(null);
          try {
            localStorage.removeItem("sokupa:lastJobId");
          } catch {
            // ignore
          }
        } else {
          // DB上は done だが result が無い（不整合）
          try {
            alert("解析は完了扱いですが、結果データが見つかりません（DBの result が空）");
          } catch {
            // ignore
          }
        }
      }
    };

    void pollOnce();
    const t = window.setInterval(() => void pollOnce(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [jobAccepted?.jobId]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-2 py-8 sm:gap-8 sm:px-4 sm:py-10 md:px-6 lg:px-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:gap-x-3">
          <p className="text-sm font-medium text-muted-foreground shrink-0">{APP_FORMAL_NAME}</p>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-2">ソクパ　- Sokupa -</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              計測メモ画像をアップロードすると、品番・計算式・実測合計を読み取り、メーカー別に整理します。発注数量は実測に
              {DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げています。
              <span className="text-xs text-muted-foreground">（※ロス率変更可能）</span>
            </p>
          </div>
          <div className="shrink-0">
            <a
              href="https://lin.ee/Xr6sd53"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-full bg-[#06C755] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#05b34c]"
            >
              LINE通知を有効にする（友だち追加）
            </a>
            <p className="text-xs text-muted-foreground mt-1">※解析完了の通知を受け取るために必要です</p>
            <p className="text-xs text-muted-foreground mt-1">※発注用テキストはアプリ上からもコピーできます</p>
          </div>
        </div>
      </header>

      <div className="space-y-8">
        <div>
          <label htmlFor={siteNameId} className="mb-1 block text-sm font-medium">
            現場名（任意）
          </label>
          <Input
            id={siteNameId}
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="例: 渋谷区〇〇マンション リビング"
            className="rounded-lg px-4 py-2 focus-visible:ring-black"
          />
        </div>

        <div>
          <span className="mb-2 block text-sm font-medium">メモ画像（複数選択可）</span>
          <div
            className={cn(
              "rounded-xl border-2 border-dashed border-border p-8 text-center transition-colors",
              "hover:bg-muted/30",
            )}
          >
            <Upload className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
            <p className="text-lg">クリックで画像を追加</p>
            <p className="mt-1 text-sm text-muted-foreground">
              PNG / JPEG / WebP / HEIC ・ 複数枚OK（最大5枚）
            </p>
            <input
              id={uploadInputId}
              type="file"
              multiple
              accept="image/*"
              onChange={(e) => void handleFileSelect(e)}
              className="sr-only"
            />
            <Button type="button" variant="default" className="mt-4" asChild>
              <label htmlFor={uploadInputId} className="cursor-pointer">
                画像を選択
              </label>
            </Button>
          </div>
        </div>

        {images.length > 0 ? (
          <div>
            <h3 className="mb-3 font-medium">選択中の画像（{images.length}枚）</h3>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {images.map((img, index) => (
                <div key={img.id} className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border bg-muted/50">
                  {img.status === "converting" && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground p-4 text-center">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-sm font-medium">変換中...</span>
                    </div>
                  )}
                  {img.status === "error" && (
                    <div className="flex flex-col items-center gap-2 text-destructive p-4 text-center">
                      <span className="text-sm font-medium">エラー</span>
                    </div>
                  )}
                  {img.status === "ready" && img.previewUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={img.previewUrl}
                      alt={`プレビュー ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFile(img.id)}
                    className="absolute right-2 top-2 rounded-full bg-destructive p-1.5 text-destructive-foreground opacity-0 shadow transition-opacity group-hover:opacity-100"
                    aria-label={`画像 ${index + 1} を削除`}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <Button
          type="button"
          onClick={() => void handleAnalyze()}
          disabled={images.length === 0 || images.some((i) => i.status !== "ready") || isAnalyzing}
          className="w-full py-6 text-base sm:text-lg"
        >
          {isAnalyzing ? (
            <span className="flex min-w-0 items-center justify-center gap-2">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
              <span className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
                <span className="sm:hidden">
                  解析中... {progress ? `${progress.done}/${progress.total}` : ""}
                </span>
                <span className="hidden sm:inline">
                  解析中... {progress ? `${progress.done}/${progress.total}` : ""}（完了後にLINEで通知します）
                </span>
              </span>
            </span>
          ) : (
            `${images.length}枚の画像を解析する`
          )}
        </Button>
        <p className="mt-3 text-center text-sm text-muted-foreground">
          ※通知が届かない場合は
          <a href="https://lin.ee/Xr6sd53" target="_blank" rel="noopener noreferrer" className="mx-1 font-bold text-[#06C755] hover:underline">
            こちらから友だち追加
          </a>
          してください。
        </p>
      </div>

      {error ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">エラー</CardTitle>
            <CardDescription className="text-destructive/90">{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {jobAccepted ? (
        <Card className="border-emerald-500/30 bg-emerald-500/10">
          <CardHeader>
            <CardTitle className="text-base">解析を受け付けました</CardTitle>
            <CardDescription>
              スマホを閉じてもサーバー側で解析が進みます。完了したらLINEで通知します。
              {jobUi ? (
                <span className="mt-2 block font-semibold text-emerald-800/90 dark:text-emerald-200">
                  {jobUi.percent}% 完了（{jobUi.done}/{jobUi.total}）
                </span>
              ) : null}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {parsed?.items?.length ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">発注テキスト</CardTitle>
            <CardDescription>LINE通知と同じ形式でコピーできます。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" className="w-full" onClick={() => void handleCopyOrderText()}>
              {copyState === "copied" ? "✅ コピーしました！" : "📋 発注テキストをコピー"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <OrderList
        items={parsed?.items ?? []}
        notes={parsed?.notes}
        siteName={siteName}
        needs_review_any={parsed?.needs_review_any}
        onItemsChange={(nextItems) =>
          setParsed((prev) => ({
            items: nextItems,
            notes: prev?.notes,
            needs_review_any: nextItems.some((i) => i.needs_review),
          }))
        }
      />
    </main>
  );
}
