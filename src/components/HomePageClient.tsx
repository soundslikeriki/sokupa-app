"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Calculator, CheckCircle2, ClipboardList, Loader2, Ruler, Upload, X } from "lucide-react";

import { AreaCalculator } from "@/components/AreaCalculator";
import { OrderDraftList, type PendingOrderDraftDuplicate } from "@/components/OrderDraftList";
import { OrderList } from "@/components/OrderList";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";
import {
  createOrderDraftItem,
  consumeOrderDraftQueue,
  mergeOrderDraftItem,
  removeOrderDraftItem,
  updateOrderDraftItem,
} from "@/lib/order-draft";
import { readWorkspaceDraft } from "@/lib/workspace-draft";
import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "@/lib/appMetadata";
import { compressImageForUpload, convertAndResizeForPreview } from "@/lib/resizeImage";

type ProcessedImage = {
  id: string;
  originalName: string;
  originalType: string;
  originalSize: number;
  previewUrl: string;
  status: "converting" | "ready" | "error";
};
import { cn } from "@/lib/utils";
import type { OrderDraftItem, OrderDraftItemInput, ParsedMemoPayload } from "@/types";

type CalculationMode = "dimensions" | "area" | "order-draft";

function createOrderDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getUploadErrorStatus(err: unknown): number | undefined {
  const anyErr = err as
    | {
        statusCode?: string | number;
        status?: string | number;
        context?: { status?: string | number };
        response?: { status?: string | number };
      }
    | null
    | undefined;
  const raw = anyErr?.statusCode ?? anyErr?.status ?? anyErr?.context?.status ?? anyErr?.response?.status;
  if (raw === undefined) return undefined;
  const num = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(num) ? num : undefined;
}

function getOriginalError(err: unknown): unknown {
  if (!err || typeof err !== "object" || !("originalError" in err)) return undefined;
  return (err as { originalError?: unknown }).originalError;
}

function getErrorDetail(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "不明なエラー";
}

function buildUploadErrorMessage(err: unknown): string {
  const message = getErrorDetail(err);
  const originalMessage = getErrorDetail(getOriginalError(err));
  const status = getUploadErrorStatus(err);
  const networkMessage = `${message} ${originalMessage}`;

  const isNetworkError =
    !status &&
    (networkMessage.includes("Load failed") ||
      networkMessage.includes("Failed to fetch") ||
      networkMessage.includes("NetworkError") ||
      networkMessage.toLowerCase().includes("network") ||
      networkMessage.toLowerCase().includes("fetch failed"));
  if (isNetworkError) {
    return "画像の保存先に接続できませんでした。時間をおいて再度お試しください。続く場合は管理者にお問い合わせください。";
  }

  if (status === 401 || status === 403) {
    return "画像のアップロード権限を確認できませんでした。ログインし直して再度お試しください。";
  }

  if (status === 404) {
    return "画像の保存先が見つかりませんでした。管理者にお問い合わせください。";
  }

  if (status === 400 || status === 413) {
    return "画像データを送信できませんでした。画像を選び直して再度お試しください。";
  }

  if (status && status >= 500) {
    return "画像の保存サービスで一時的な問題が発生しています。時間をおいて再度お試しください。";
  }

  return "画像のアップロードに失敗しました。時間をおいて再度お試しください。";
}

type UploadFileContext = {
  originalName: string;
  originalType: string;
  originalSize: number;
};

// ネットワーク一時障害を想定し、失敗時に1回だけ自動リトライする
async function uploadImageToStorage(_path: string, blob: Blob, _fileContext: UploadFileContext): Promise<string> {
  const uploadId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch("/api/memo-images", { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Upload-Id": uploadId }, body: blob, signal: AbortSignal.timeout(45_000) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "画像の保存に失敗しました"), { status: response.status });
      if (typeof result.object_path !== "string") throw new Error("画像の保存結果が不正です");
      return result.object_path;
    } catch (error) {
      const status = getUploadErrorStatus(error);
      if (attempt || (status && status < 500)) throw new Error(buildUploadErrorMessage(error));
    }
  }
  throw new Error("画像の保存に失敗しました");
}

async function fetchAnalysisJob(id: string) {
  const response = await fetch(`/api/analysis-jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
  const payload = await response.json();
  return { data: response.ok ? payload.data : null, error: response.ok ? null : payload.error };
}

export default function HomePageClient() {
  const uploadInputId = useId();
  const siteNameId = useId();
  const [siteName, setSiteName] = useState("");
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [parsed, setParsed] = useState<ParsedMemoPayload | null>(null);
  const [originalParsed, setOriginalParsed] = useState<ParsedMemoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobAccepted, setJobAccepted] = useState<{ jobId: string } | null>(null);
  const [calculationMode, setCalculationMode] = useState<CalculationMode>("dimensions");
  const [areaCalculatorMounted, setAreaCalculatorMounted] = useState(false);
  const [orderDraftItems, setOrderDraftItems] = useState<OrderDraftItem[]>([]);
  const [pendingOrderDraftDuplicate, setPendingOrderDraftDuplicate] =
    useState<PendingOrderDraftDuplicate | null>(null);
  const [pendingOrderDraftQueue, setPendingOrderDraftQueue] = useState<OrderDraftItem[]>([]);
  const [orderDraftFeedback, setOrderDraftFeedback] = useState<string | null>(null);
  const orderDraftFeedbackTimeoutRef = useRef<number | null>(null);
  const [jobUi, setJobUi] = useState<{
    status: "queued" | "running" | "done" | "failed";
    done: number;
    total: number;
    percent: number;
  } | null>(null);

  const readyImages = useMemo(
    () => images.filter((img) => img.status === "ready" && img.previewUrl),
    [images],
  );

  const showOrderDraftFeedback = useCallback((count: number) => {
    if (count <= 0) return;
    if (orderDraftFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(orderDraftFeedbackTimeoutRef.current);
    }
    setOrderDraftFeedback(count === 1 ? "発注リストに追加しました" : `${count}件を発注リストに追加しました`);
    orderDraftFeedbackTimeoutRef.current = window.setTimeout(() => {
      setOrderDraftFeedback(null);
      orderDraftFeedbackTimeoutRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (orderDraftFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(orderDraftFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const processOrderDraftQueue = useCallback(
    (baseItems: OrderDraftItem[], queue: OrderDraftItem[], resolvedCount = 0) => {
      const result = consumeOrderDraftQueue(baseItems, queue);
      setOrderDraftItems(result.items);
      setPendingOrderDraftDuplicate(result.pending);
      setPendingOrderDraftQueue(result.remaining);
      showOrderDraftFeedback(resolvedCount + result.addedCount);
    },
    [showOrderDraftFeedback],
  );

  const requestAddToOrderDraft = useCallback(
    (input: OrderDraftItemInput) => {
      const incoming = createOrderDraftItem(input, createOrderDraftId());
      processOrderDraftQueue(orderDraftItems, [incoming]);
      setCalculationMode("order-draft");
    },
    [orderDraftItems, processOrderDraftQueue],
  );

  const requestAddAllToOrderDraft = useCallback(
    (inputs: OrderDraftItemInput[]) => {
      const incoming = inputs.map((input) => createOrderDraftItem(input, createOrderDraftId()));
      processOrderDraftQueue(orderDraftItems, incoming);
      setCalculationMode("order-draft");
    },
    [orderDraftItems, processOrderDraftQueue],
  );

  const updateOrderDraft = useCallback(
    (
      id: string,
      patch: Partial<Pick<OrderDraftItem, "productCode" | "quantity" | "unit" | "manufacturer" | "note">>,
    ) => {
      setOrderDraftItems((current) => updateOrderDraftItem(current, id, patch));
    },
    [],
  );

  const deleteOrderDraft = useCallback((id: string) => {
    setOrderDraftItems((current) => removeOrderDraftItem(current, id));
    setPendingOrderDraftDuplicate((current) =>
      current?.existingId === id ? null : current,
    );
    setPendingOrderDraftQueue([]);
  }, []);

  const mergePendingOrderDraft = useCallback(() => {
    if (!pendingOrderDraftDuplicate) return;
    const merged = mergeOrderDraftItem(
      orderDraftItems,
      pendingOrderDraftDuplicate.existingId,
      pendingOrderDraftDuplicate.incoming,
    );
    processOrderDraftQueue(merged, pendingOrderDraftQueue, 1);
  }, [orderDraftItems, pendingOrderDraftDuplicate, pendingOrderDraftQueue, processOrderDraftQueue]);

  const keepPendingOrderDraftSeparate = useCallback(() => {
    if (!pendingOrderDraftDuplicate) return;
    processOrderDraftQueue(
      [...orderDraftItems, pendingOrderDraftDuplicate.incoming],
      pendingOrderDraftQueue,
      1,
    );
  }, [orderDraftItems, pendingOrderDraftDuplicate, pendingOrderDraftQueue, processOrderDraftQueue]);

  const cancelPendingOrderDraft = useCallback(() => {
    processOrderDraftQueue(orderDraftItems, pendingOrderDraftQueue);
  }, [orderDraftItems, pendingOrderDraftQueue, processOrderDraftQueue]);

  const [draftReady, setDraftReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const session = await response.json();
        if (!response.ok || !session.authenticated || cancelled) return;
        setLineUserId(session.line_user_id);
        const saved = localStorage.getItem(`sokupa:workspace:v1:${session.line_user_id}`);
        if (saved) {
          const draft = readWorkspaceDraft(saved);
          setSiteName(typeof draft.siteName === "string" ? draft.siteName : "");
          setParsed(draft.parsed);
          setOriginalParsed(draft.originalParsed ?? draft.parsed);
          setOrderDraftItems(draft.orderDraftItems);
        }
        setDraftReady(true);
      } catch (error) { if (!cancelled) setError(getErrorDetail(error)); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draftReady || !lineUserId) return;
    try {
      localStorage.setItem(`sokupa:workspace:v1:${lineUserId}`, JSON.stringify({ version: 1, siteName, parsed, originalParsed, orderDraftItems }));
    } catch { setError("端末への下書き保存に失敗しました。必要な内容をコピーして保存してください。"); }
  }, [draftReady, lineUserId, siteName, parsed, originalParsed, orderDraftItems]);

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
      originalType: file.type || "unknown",
      originalSize: file.size,
      previewUrl: "",
      status: "converting" as const,
    }));

    setImages((prev) => [...prev, ...newImages]);
    setError(null);

    void (async () => {
      for (let idx = 0; idx < newImages.length; idx++) {
        const imgObj = newImages[idx];
        const file = imageFiles[idx];
        try {
          console.log("[Sokupa] 画像変換開始", {
            imageId: imgObj.id,
            fileName: file.name,
            fileType: file.type || "unknown",
            sizeBytes: file.size,
          });
          // Send 1500px max dimension image at 0.6 quality to aggressively reduce payload
          // Mobile HEIC/JPEG を AI が読み取りやすいサイズへ（長辺 2000px 目安）
          const dataUrl = await convertAndResizeForPreview(file, 2000, 0.72);
          console.log("[Sokupa] 画像変換完了", {
            imageId: imgObj.id,
            fileName: file.name,
            dataUrlLength: dataUrl.length,
          });
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id
                ? {
                    ...img,
                    previewUrl: dataUrl,
                    status: "ready",
                  }
                : img
            )
          );
        } catch (err) {
          console.error("[Sokupa] 画像変換失敗", {
            imageId: imgObj.id,
            fileName: file.name,
            error: err,
          });
          setError(`画像の読み込み・変換に失敗しました（${file.name}）: ${getErrorDetail(err)}`);
          setImages((prev) =>
            prev.map((img) =>
              img.id === imgObj.id ? { ...img, status: "error" } : img
            )
          );
        }
      }
    })();
  }, [imageCount]);

  const removeFile = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleAnalyze = async () => {
    if (!draftReady || jobAccepted) return;
    if (isAnalyzing) return;
    if (readyImages.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    setProgress({ done: 0, total: readyImages.length });
    setJobAccepted(null);
    setJobUi(null);

    try {
      // Save prepared JPEGs through the authenticated server API.
      const uploadedUrls: string[] = [];
      for (let i = 0; i < readyImages.length; i++) {
        const img = readyImages[i]!;
        console.log("[Sokupa] アップロード前圧縮開始", {
          imageId: img.id,
          imageIndex: i + 1,
          totalImages: readyImages.length,
        });

        let blob: Blob;
        try {
          // 転送量削減のため、アップロード前に長辺1500px・品質0.8で再圧縮する
          blob = await compressImageForUpload(img.previewUrl, 1500, 0.8);
        } catch (err) {
          console.error("[Sokupa] アップロード前圧縮失敗", {
            imageId: img.id,
            imageIndex: i + 1,
            error: err,
          });
          throw new Error(`画像の圧縮に失敗しました: ${getErrorDetail(err)}`);
        }

        console.log("[Sokupa] アップロード前圧縮完了", {
          imageId: img.id,
          imageIndex: i + 1,
          sizeBytes: blob.size,
          contentType: blob.type,
        });

        const path = `uploads/${Date.now()}_${img.id}.jpg`;
        const objectPath = await uploadImageToStorage(path, blob, {
          originalName: img.originalName,
          originalType: img.originalType,
          originalSize: img.originalSize,
        });
        uploadedUrls.push(objectPath);

        setProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + 1) } : null));
      }

      // 2) create a background analysis job on the server
      const createRes = await fetch("/api/analysis-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_paths: uploadedUrls,
          site_name: siteName?.trim() || undefined,
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

      if (parsed) {
        try { localStorage.setItem(`sokupa:workspace:v1:${lineUserId}:previous`, JSON.stringify({ version: 1, siteName, parsed, originalParsed, orderDraftItems })); }
        catch { setError("前回の結果を端末に保存できませんでした。必要な内容をコピーしてください。"); }
      }
      setParsed(null);
      setOriginalParsed(null);
      setJobAccepted({ jobId: String(createJson.job_id) });
      try {
        localStorage.setItem(`sokupa:lastJobId:${lineUserId}`, String(createJson.job_id));
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("[Sokupa] 画像アップロード・解析受付フロー失敗", err);
      setError(getErrorDetail(err) || "解析中にエラーが発生しました");
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
    }
  };

  // Restore last job on reload (so closing browser continues UX)
  useEffect(() => {
    if (!draftReady) return;
    let cancelled = false;
    (async () => {
      try {
        const last = localStorage.getItem(`sokupa:lastJobId:${lineUserId}`) || localStorage.getItem("sokupa:lastJobId");
        if (!last) return;
        const { data, error } = await fetchAnalysisJob(last);
        if (cancelled) return;
        if (error || !data) {
          if (data === null && error === "Not found") {
            localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`);
            localStorage.removeItem("sokupa:lastJobId");
          }
          return;
        }
        if (data.status === "done" && data.result) {
          if (data.site_name) setSiteName(data.site_name);
          setParsed(data.result as ParsedMemoPayload);
          setOriginalParsed(data.result as ParsedMemoPayload);
          localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`);
          localStorage.removeItem("sokupa:lastJobId");
          return;
        }
        if (data.status === "failed") {
          try {
            alert(`前回の解析が失敗しています\n${String(data.error || "unknown")}`);
          } catch {
            // ignore
          }
          localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`);
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
  }, [draftReady, lineUserId]);

  // Poll job status every ~3s and auto-show results when done
  useEffect(() => {
    if (!jobAccepted?.jobId) return;
    let cancelled = false;

    let polling = false;
    const pollOnce = async () => {
      const { data, error: qErr } = await fetchAnalysisJob(jobAccepted.jobId);
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
          localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`);
          localStorage.removeItem("sokupa:lastJobId");
        } catch {
          // ignore
        }
      }

      if (status === "done") {
        if (data.result) {
          if (data.site_name) setSiteName(data.site_name);
          setParsed(data.result as ParsedMemoPayload);
          setOriginalParsed(data.result as ParsedMemoPayload);
          setJobAccepted(null);
          setJobUi(null);
          try {
            localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`);
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

    const poll = () => {
      if (polling) return;
      polling = true;
      void pollOnce().catch(() => { if (!cancelled) setError("結果を取得できません。通信の回復後に再確認します。"); }).finally(() => { polling = false; });
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [jobAccepted?.jobId, lineUserId]);

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

      <div
        role="tablist"
        aria-label="クロス数量の計算方法"
        className="grid grid-cols-3 gap-1 rounded-lg border border-black/5 bg-black/5 p-1 dark:border-white/5 dark:bg-white/5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={calculationMode === "dimensions"}
          aria-controls="dimensions-calculator-panel"
          className={cn(
            "flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-xs font-bold transition-colors sm:text-sm",
            calculationMode === "dimensions"
              ? "bg-white text-foreground shadow-sm dark:bg-black"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setCalculationMode("dimensions")}
        >
          <Ruler className="h-4 w-4 shrink-0" />
          <span className="sm:hidden">寸法計算</span>
          <span className="hidden sm:inline">寸法から計算</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={calculationMode === "area"}
          aria-controls="area-calculator-panel"
          className={cn(
            "flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-xs font-bold transition-colors sm:text-sm",
            calculationMode === "area"
              ? "bg-white text-foreground shadow-sm dark:bg-black"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => {
            setAreaCalculatorMounted(true);
            setCalculationMode("area");
          }}
        >
          <Calculator className="h-4 w-4 shrink-0" />
          <span className="sm:hidden">㎡計算</span>
          <span className="hidden sm:inline">㎡から計算</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={calculationMode === "order-draft"}
          aria-controls="order-draft-panel"
          className={cn(
            "flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-bold transition-colors sm:gap-2 sm:px-2 sm:text-sm",
            calculationMode === "order-draft"
              ? "bg-white text-foreground shadow-sm dark:bg-black"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setCalculationMode("order-draft")}
        >
          <ClipboardList className="h-4 w-4 shrink-0" />
          <span className="truncate">発注リスト</span>
          {orderDraftItems.length > 0 ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 px-1 text-[10px] text-white">
              {orderDraftItems.length}
            </span>
          ) : null}
        </button>
      </div>

      {orderDraftFeedback ? (
        <div
          role="status"
          className="flex min-h-11 items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-bold text-emerald-800 dark:text-emerald-200"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          {orderDraftFeedback}
        </div>
      ) : null}

      <section
        id="dimensions-calculator-panel"
        role="tabpanel"
        hidden={calculationMode !== "dimensions"}
        className="space-y-6 sm:space-y-8"
      >

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
            <p className="mt-1 flex flex-wrap justify-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground sm:text-sm">
              <span className="whitespace-nowrap">PNG / JPEG / WebP / HEIC</span>
              <span aria-hidden>・</span>
              <span className="whitespace-nowrap">複数枚OK（最大5枚）</span>
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
        <p className="mt-3 text-center text-xs text-muted-foreground sm:text-sm">
          ※通知が届かない場合は
          <a href="https://lin.ee/Xr6sd53" target="_blank" rel="noopener noreferrer" className="mx-1 font-bold text-[#06C755] hover:underline">
            こちらから友だち追加
          </a>
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

      <OrderList
        items={parsed?.items ?? []}
        sourceItems={originalParsed?.items}
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
        onAddToOrderDraft={requestAddToOrderDraft}
        onAddAllToOrderDraft={requestAddAllToOrderDraft}
      />
      </section>

      {areaCalculatorMounted ? (
        <section id="area-calculator-panel" role="tabpanel" hidden={calculationMode !== "area"}>
          <AreaCalculator onAddToOrderDraft={requestAddToOrderDraft} />
        </section>
      ) : null}

      <section id="order-draft-panel" role="tabpanel" hidden={calculationMode !== "order-draft"}>
        <OrderDraftList
          items={orderDraftItems}
          siteName={siteName}
          pendingDuplicate={pendingOrderDraftDuplicate}
          onUpdate={updateOrderDraft}
          onSiteNameChange={setSiteName}
          onDelete={deleteOrderDraft}
          onManualAdd={requestAddToOrderDraft}
          onMergeDuplicate={mergePendingOrderDraft}
          onKeepDuplicateSeparate={keepPendingOrderDraftSeparate}
          onCancelDuplicate={cancelPendingOrderDraft}
        />
      </section>
    </main>
  );
}
