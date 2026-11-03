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
import { readWorkspaceDraft, archiveWorkspaceDraft, workspaceContainsJobResult, workspaceWouldBeReplacedByResult, listWorkspaceArchives, switchWorkspaceDraft, retainDeferredJobResult, type WorkspaceArchive, type WorkspaceDraft } from "@/lib/workspace-draft";
import { notificationRetryable, analysisBlocksIntake, mergeNotificationWatch, forgetJobPointerIfMatches, needsAnalysisRestoration, type NotificationWatch } from "@/lib/notification-watch";
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

type HistoryJob = { id: string; site_name: string | null; created_at: string; notification_status: string };

type CalculationMode = "dimensions" | "area" | "order-draft";

function describeMemo(memo: ParsedMemoPayload | null): string {
  if (!memo?.items.length) return "解析結果なし";
  return memo.items.slice(0, 3).map((item) => `${item.product_code}: ${item.order_quantity}m`).join(" / ") + (memo.items.length > 3 ? " ほか" : "");
}

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
  const [jobAccepted, setJobAccepted] = useState<{ jobId: string; backgroundReady: boolean; status?: string } | null>(null);
  const analysisSelectionVersionRef = useRef(0);
  const [analysisRecoveryEpoch, setAnalysisRecoveryEpoch] = useState(0);
  const [explicitSelectionEpoch, setExplicitSelectionEpoch] = useState(0);
  const appliedJobRef = useRef<string | null>(null);
  const [notificationWatches, setNotificationWatches] = useState<NotificationWatch[]>([]);
  const notificationWatchesRef = useRef<NotificationWatch[]>([]);
  const notificationRetryAtRef = useRef<Record<string, number>>({});
  const kickNotificationPollRef = useRef<(() => void) | null>(null);
  const rememberNotification = useCallback((watch: NotificationWatch) => {
    const next = mergeNotificationWatch(notificationWatchesRef.current, watch);
    notificationWatchesRef.current = next; setNotificationWatches(next);
  }, []);
  const trackNotification = useCallback((watch: NotificationWatch) => {
    rememberNotification(watch); kickNotificationPollRef.current?.();
  }, [rememberNotification]);
  const restoredDraftRef = useRef<WorkspaceDraft | null>(null);
  const currentWorkspaceRef = useRef<WorkspaceDraft | null>(null);
  const persistedWorkspaceRef = useRef<string | null>(null);
  const switchAttemptRef = useRef<{ snapshot: string; expected: string | null; next: string; suffix: string } | null>(null);
  const [workspaceArchives, setWorkspaceArchives] = useState<WorkspaceArchive[]>([]);
  const [pendingJobResult, setPendingJobResult] = useState<{ jobId: string; siteName: string | null; result: ParsedMemoPayload; backgroundReady: boolean } | null>(null);
  const pendingJobResultRef = useRef<typeof pendingJobResult>(null);
  const [resultChoiceDeferred, setResultChoiceDeferred] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<HistoryJob[] | null>(null);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [resultRetentionError, setResultRetentionError] = useState<string | null>(null);
  const [resultJobId, setResultJobId] = useState<string | null>(null);
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
    notificationStatus?: string;
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
  const [draftRecovery, setDraftRecovery] = useState<{ key: string; raw: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const session = await response.json();
        if (!response.ok || !session.authenticated || cancelled) return;
        setLineUserId(session.line_user_id);
        const saved = localStorage.getItem(`sokupa:workspace:v1:${session.line_user_id}`);
        persistedWorkspaceRef.current = saved;
        setWorkspaceArchives(listWorkspaceArchives(localStorage, `sokupa:workspace:v1:${session.line_user_id}`));
        if (saved) {
          let draft;
          try { draft = readWorkspaceDraft(saved); }
          catch (error) { setDraftRecovery({ key: `sokupa:workspace:v1:${session.line_user_id}`, raw: saved }); throw error; }
          restoredDraftRef.current = draft;
          appliedJobRef.current = draft.parsed ? draft.resultJobId ?? null : null;
          setResultJobId(appliedJobRef.current);
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
    if (draftReady) currentWorkspaceRef.current = { version: 1, siteName, parsed, originalParsed, orderDraftItems, resultJobId };
  }, [draftReady, siteName, parsed, originalParsed, orderDraftItems, resultJobId]);

  useEffect(() => {
    if (!draftReady || !lineUserId) return;
    try {
      const key = `sokupa:workspace:v1:${lineUserId}`;
      if (localStorage.getItem(key) !== persistedWorkspaceRef.current) throw new Error("Workspace changed in another tab");
      const serialized = JSON.stringify({ version: 1, siteName, parsed, originalParsed, orderDraftItems, resultJobId });
      localStorage.setItem(key, serialized);
      if (localStorage.getItem(key) !== serialized) throw new Error("Draft persistence failed");
      persistedWorkspaceRef.current = serialized;
      if (parsed && resultJobId) void fetch(`/api/analysis-jobs/${encodeURIComponent(resultJobId)}/seen`, { method: "POST" }).catch(() => undefined);
    } catch { setError("端末への下書き保存に失敗しました。必要な内容をコピーして保存してください。"); }
  }, [draftReady, lineUserId, siteName, parsed, originalParsed, orderDraftItems, resultJobId]);

  const downloadWorkspace = (raw: string) => {
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "sokupa-workspace.json"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const safelySwitchWorkspace = (next: WorkspaceDraft) => {
    if (!lineUserId || !currentWorkspaceRef.current) throw new Error("下書きの準備ができていません。");
    const key = `sokupa:workspace:v1:${lineUserId}`, current = currentWorkspaceRef.current;
    const snapshot = JSON.stringify(current), expected = persistedWorkspaceRef.current, nextRaw = JSON.stringify(next);
    let attempt = switchAttemptRef.current;
    if (!attempt || attempt.snapshot !== snapshot || attempt.expected !== expected || attempt.next !== nextRaw) {
      attempt = { snapshot, expected, next: nextRaw, suffix: `${Date.now()}-${crypto.randomUUID()}` }; switchAttemptRef.current = attempt;
    }
    const switched = switchWorkspaceDraft(localStorage, key, expected, current, next, attempt.suffix);
    analysisSelectionVersionRef.current++;
    persistedWorkspaceRef.current = switched.raw; currentWorkspaceRef.current = next;
    appliedJobRef.current = next.parsed ? next.resultJobId ?? null : null; restoredDraftRef.current = next;
    setSiteName(next.siteName); setParsed(next.parsed); setOriginalParsed(next.originalParsed ?? next.parsed);
    setOrderDraftItems(next.orderDraftItems); setResultJobId(next.resultJobId ?? null);
    setJobAccepted(null); setJobUi(null); setError(null);
    try { setWorkspaceArchives(listWorkspaceArchives(localStorage, key)); }
    catch { setWorkspaceArchives((previous) => [...switched.archives, ...previous.filter((entry) => !switched.archives.some((saved) => saved.key === entry.key))]); }
  };

  const retainPendingResult = (pending: NonNullable<typeof pendingJobResult>) => {
    if (!lineUserId) throw new Error("ログイン情報を確認できません。");
    const key = `sokupa:workspace:v1:${lineUserId}`;
    const archive = retainDeferredJobResult(localStorage, key, pending.jobId, pending.siteName, pending.result);
    setWorkspaceArchives((previous) => [archive, ...previous.filter((entry) => entry.key !== archive.key)]);
  };

  const deferPendingJobResult = () => {
    const pending = pendingJobResultRef.current;
    if (!pending) return;
    try { retainPendingResult(pending); setResultChoiceDeferred(true); }
    catch (error) { setError(`後回しにする結果を端末へ保管できませんでした。まだこの画面に保持しています。結果を書き出すか、保存領域を確保して再度お試しください。 ${getErrorDetail(error)}`); }
  };

  const loadHistory = async (before?: string) => {
    if (historyLoading) return;
    setHistoryLoading(true); setHistoryError(null);
    try {
      const response = await fetch(`/api/analysis-jobs?history=1${before ? `&before=${encodeURIComponent(before)}` : ""}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.data)) throw new Error("保存済みの解析結果を取得できませんでした。再度お試しください。");
      setHistoryJobs((current) => before ? [...(current ?? []), ...payload.data.filter((job: HistoryJob) => !current?.some((entry) => entry.id === job.id))] : payload.data);
      setHistoryNext(payload.next_before ?? null);
    } catch (error) { setHistoryError(getErrorDetail(error)); }
    finally { setHistoryLoading(false); }
  };

  const openPendingJobResult = () => {
    const pending = pendingJobResultRef.current, current = currentWorkspaceRef.current;
    if (!pending || !current) return;
    try {
      safelySwitchWorkspace({ ...current, siteName: pending.siteName ?? "", parsed: pending.result, originalParsed: pending.result, resultJobId: pending.jobId });
      appliedJobRef.current = pending.jobId; restoredDraftRef.current = null;
      pendingJobResultRef.current = null; setPendingJobResult(null); setResultChoiceDeferred(false);
      setJobAccepted({ jobId: pending.jobId, backgroundReady: pending.backgroundReady, status: "done" });
      try { localStorage.setItem(`sokupa:lastJobId:${lineUserId}`, pending.jobId); } catch { /* The saved workspace and server discovery remain available. */ }
    } catch (error) { setError(`今の下書きを保持しています。退避・切替できませんでした。 ${getErrorDetail(error)}`); }
  };

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
    if (!draftReady || analysisBlocksIntake(jobAccepted)) return;
    if (isAnalyzing) return;
    if (readyImages.length === 0) return;
    try { if (pendingJobResultRef.current) retainPendingResult(pendingJobResultRef.current); }
    catch { setResultRetentionError("別の解析結果を端末へ保管できませんでした。サーバーの「保存済みの解析結果」から開けます。"); }
    const previousAnalysis = jobAccepted, previousUi = jobUi;
    const admissionVersion = ++analysisSelectionVersionRef.current;
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

      const current = currentWorkspaceRef.current;
      if (current?.parsed || current?.originalParsed) {
        try { safelySwitchWorkspace({ ...current, parsed: null, originalParsed: null, resultJobId: null }); }
        catch { setError("前回の編集を退避できなかったため、下書きを残して解析を続けます。完了後に切替方法を選べます。"); }
      } else {
        setParsed(null); setOriginalParsed(null); setResultJobId(null);
        appliedJobRef.current = null; restoredDraftRef.current = null;
      }
      setJobAccepted({ jobId: String(createJson.job_id), backgroundReady: createJson.background_ready === true && ["scheduled", "scheduled-wake"].includes(createJson.execution_mode), status: "queued" });
      try {
        localStorage.setItem(`sokupa:lastJobId:${lineUserId}`, String(createJson.job_id));
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("[Sokupa] 画像アップロード・解析受付フロー失敗", err);
      setError(getErrorDetail(err) || "解析中にエラーが発生しました");
      if (analysisSelectionVersionRef.current === admissionVersion) {
        setJobAccepted(previousAnalysis); setJobUi(previousUi);
        setAnalysisRecoveryEpoch((current) => current + 1);
      }
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
    }
  };

  // The server remains authoritative when localStorage is blocked, full or cleared.
  useEffect(() => {
    if (!draftReady || !lineUserId) return;
    const selectionVersion = analysisSelectionVersionRef.current;
    let cancelled = false;
    void (async () => {
      let last: string | null = null;
      try { last = localStorage.getItem(`sokupa:lastJobId:${lineUserId}`) || localStorage.getItem("sokupa:lastJobId"); } catch { /* Recover from the server. */ }
      try {
        let pointedJob = false;
        if (last) {
          const { data } = await fetchAnalysisJob(last);
          if (data && !cancelled) {
            pointedJob = needsAnalysisRestoration(data, true);
            if (pointedJob && selectionVersion === analysisSelectionVersionRef.current) setJobAccepted((current) => current ?? { jobId: last!, backgroundReady: data.background_ready === true, status: data.status });
            if (data.status === "done" && notificationRetryable(data.notification_status)) trackNotification({ jobId: last, siteName: data.site_name ?? null, status: data.notification_status });
          }
        }
        const response = await fetch("/api/analysis-jobs", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error("前回の解析を確認できませんでした。通信の回復後に再読込してください。");
        const jobs = Array.isArray(payload.data) ? payload.data : [];
        if (cancelled) return;
        for (const job of jobs) if (job.status === "done" && notificationRetryable(job.notification_status)) trackNotification({ jobId: job.id, siteName: job.site_name ?? null, status: job.notification_status });
        const found = jobs.find((job: { status: string; client_result_seen_at?: string | null }) => needsAnalysisRestoration(job));
        if (!pointedJob && found?.id && selectionVersion === analysisSelectionVersionRef.current) setJobAccepted((current) => current ?? { jobId: found.id, backgroundReady: false, status: found.status });
      } catch { if (!cancelled && selectionVersion === analysisSelectionVersionRef.current) setError("前回の解析を確認できませんでした。通信の回復後に再読込してください。"); }
    })();
    return () => { cancelled = true; };
  }, [draftReady, lineUserId, trackNotification, analysisRecoveryEpoch]);

  // Notification-only reads/retries never apply results, switch drafts or lock the next analysis.
  useEffect(() => {
    if (!draftReady || !lineUserId) return;
    let cancelled = false, polling = false;
    const pollOnce = async () => {
      const pending = notificationWatchesRef.current.filter((watch) => notificationRetryable(watch.status));
      for (const watch of pending) {
        try {
          const { data, error: fetchError } = await fetchAnalysisJob(watch.jobId);
          if (cancelled) return;
          if (fetchError || !data || data.status !== "done") {
            rememberNotification({ ...watch, error: "通知状態を取得できません。通信の回復後に再確認します。" }); continue;
          }
          const status = data.notification_status ?? watch.status;
          rememberNotification({ jobId: watch.jobId, siteName: data.site_name ?? watch.siteName, status, error: null });
          if (!notificationRetryable(status)) {
            delete notificationRetryAtRef.current[watch.jobId];
            try {
              const saved = persistedWorkspaceRef.current ? readWorkspaceDraft(persistedWorkspaceRef.current) : null;
              if (workspaceContainsJobResult(saved, watch.jobId)) forgetJobPointerIfMatches(localStorage, lineUserId, watch.jobId);
            } catch { /* Discovery and server notification state remain authoritative. */ }
          } else if (data.can_resume && Date.now() >= (notificationRetryAtRef.current[watch.jobId] ?? 0)) {
            notificationRetryAtRef.current[watch.jobId] = Date.now() + 30_000;
            const response = await fetch(`/api/analysis-jobs/${encodeURIComponent(watch.jobId)}/resume`, { method: "POST" });
            if (cancelled) return;
            if (!response.ok) rememberNotification({ jobId: watch.jobId, siteName: data.site_name ?? watch.siteName, status, error: "LINE通知は通信の回復後に再確認します。" });
          }
        } catch { if (!cancelled) rememberNotification({ ...watch, error: "LINE通知は通信の回復後に再確認します。" }); }
      }
    };
    const poll = () => {
      if (polling) return; polling = true;
      void pollOnce().finally(() => { polling = false; });
    };
    kickNotificationPollRef.current = poll; poll();
    const timer = window.setInterval(poll, 5000);
    return () => { cancelled = true; window.clearInterval(timer); if (kickNotificationPollRef.current === poll) kickNotificationPollRef.current = null; };
  }, [draftReady, lineUserId, rememberNotification]);

  // Restore the selected result; completed work hands notifications to the watcher above.
  useEffect(() => {
    if (!jobAccepted?.jobId) return;
    const jobId = jobAccepted.jobId, selectionVersion = analysisSelectionVersionRef.current;
    let cancelled = false, polling = false, nextResumeAt = 0;
    const forgetPointer = () => {
      try { if (lineUserId) forgetJobPointerIfMatches(localStorage, lineUserId, jobId); } catch { /* Server discovery survives this failure. */ }
    };
    const pollOnce = async () => {
      const { data, error: qErr } = await fetchAnalysisJob(jobId);
      if (cancelled || qErr || !data || selectionVersion !== analysisSelectionVersionRef.current) return;
      setJobAccepted((current) => current?.jobId === jobId ? { ...current, backgroundReady: data.background_ready === true, status: data.status } : current);
      const status = (data.status as "queued" | "running" | "done" | "failed") || "queued";
      const done = Number(data.done_images) || 0, total = Math.max(1, Number(data.total_images) || 1);
      setJobUi({ status, done, total, percent: Math.min(100, Math.max(0, Math.round(done / total * 100))), notificationStatus: data.notification_status });
      if (status === "done" && data.result && appliedJobRef.current !== jobId) {
        const current = currentWorkspaceRef.current;
        if (workspaceWouldBeReplacedByResult(current, jobId, data.site_name ?? null)) {
          if (pendingJobResultRef.current?.jobId !== jobId) setResultChoiceDeferred(false);
          const pending = { jobId, siteName: data.site_name ?? null, result: data.result as ParsedMemoPayload, backgroundReady: data.background_ready === true };
          pendingJobResultRef.current = pending; setPendingJobResult(pending);
        } else {
          const retainEdits = workspaceContainsJobResult(current ?? restoredDraftRef.current, jobId);
          appliedJobRef.current = jobId; setResultJobId(jobId); restoredDraftRef.current = null;
          if (!retainEdits) {
            setSiteName(data.site_name ?? "");
            setParsed(data.result as ParsedMemoPayload); setOriginalParsed(data.result as ParsedMemoPayload);
          }
        }
      }
      if (status === "done" && data.result) {
        if (notificationRetryable(data.notification_status)) trackNotification({ jobId, siteName: data.site_name ?? null, status: data.notification_status });
        else {
          if (["uncertain", "legacy_unknown"].includes(data.notification_status)) rememberNotification({ jobId, siteName: data.site_name ?? null, status: data.notification_status });
          if (appliedJobRef.current === jobId) forgetPointer();
        }
        setJobAccepted((current) => current?.jobId === jobId ? null : current); setJobUi(null);
        return;
      }
      if (data.can_resume && status !== "done" && Date.now() >= nextResumeAt) {
        nextResumeAt = Date.now() + 30_000;
        const resumed = await fetch(`/api/analysis-jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST" });
        if (cancelled || selectionVersion !== analysisSelectionVersionRef.current) return;
        if (!resumed.ok) setError("解析を再開できませんでした。通信の回復後に再度確認します。");
      }
      if (status === "failed") {
        setError(String(data.error || "解析に失敗しました"));
        void fetch(`/api/analysis-jobs/${encodeURIComponent(jobId)}/seen`, { method: "POST" }).catch(() => undefined);
        setJobAccepted((current) => current?.jobId === jobId ? null : current); setJobUi(null); forgetPointer();
      } else if (status === "done" && !data.result) setError("解析結果を取得できませんでした。保存された仕事を再確認しています。");
    };
    const poll = () => {
      if (polling) return; polling = true;
      void pollOnce().catch(() => { if (!cancelled && selectionVersion === analysisSelectionVersionRef.current) setError("結果を取得できません。通信の回復後に再確認します。"); }).finally(() => { polling = false; });
    };
    poll(); const timer = window.setInterval(poll, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [jobAccepted?.jobId, lineUserId, rememberNotification, trackNotification, analysisRecoveryEpoch, explicitSelectionEpoch]);

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
          disabled={!draftReady || analysisBlocksIntake(jobAccepted) || images.length === 0 || images.some((i) => i.status !== "ready") || isAnalyzing}
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

      {notificationWatches.length ? (
        <Card>
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">LINE通知</CardTitle>
            {notificationWatches.some((watch) => notificationRetryable(watch.status)) ? <CardDescription>LINE通知を再確認しています。解析結果は利用でき、新しい解析も開始できます。</CardDescription> : null}
            {notificationWatches.map((watch) => (
              <div key={watch.jobId} className="rounded border p-3 text-sm" aria-label={`${watch.siteName || "現場名なし"}の通知状態`}>
                <p className="font-medium">{watch.siteName || "現場名なし"}: {notificationRetryable(watch.status) ? "通知を再確認中" : watch.status === "accepted" ? "LINE受付済み" : "通知状況は要確認"}</p>
                {watch.error ? <p className="mt-1 text-muted-foreground">{watch.error}</p> : null}
              </div>
            ))}
          </CardHeader>
        </Card>
      ) : null}

      {pendingJobResult ? (
        <Card className="border-amber-500/50">
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">別の解析結果があります</CardTitle>
            <CardDescription>今の下書き「{siteName || "現場名なし"}」は保持しています。別の解析「{pendingJobResult.siteName || "現場名なし"}」はサーバーに保存されています。</CardDescription>
            <p className="text-sm">今の編集: {describeMemo(parsed)}</p>
            <p className="text-sm">別の解析: {describeMemo(pendingJobResult.result)}</p>
            {resultChoiceDeferred ? (
              <Button type="button" variant="outline" onClick={() => setResultChoiceDeferred(false)}>別の結果を確認する</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={deferPendingJobResult}>今の下書きを続ける</Button>
                <Button type="button" className="h-auto min-h-10 max-w-full whitespace-normal py-2" onClick={openPendingJobResult}>今の下書きを退避して別の結果を開く</Button>
              </>
            )}
            <Button type="button" variant="outline" onClick={() => { if (currentWorkspaceRef.current) downloadWorkspace(JSON.stringify(currentWorkspaceRef.current)); }}>今の下書きを書き出す</Button>
            <Button type="button" variant="outline" onClick={() => downloadWorkspace(JSON.stringify({ version: 1, siteName: pendingJobResult.siteName ?? "", parsed: pendingJobResult.result, originalParsed: pendingJobResult.result, orderDraftItems: [], resultJobId: pendingJobResult.jobId }))}>別の解析結果を書き出す</Button>
            {resultChoiceDeferred ? <p className="text-sm text-muted-foreground">後回しにした結果は「退避した下書き」からも開けます。</p> : null}
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="text-base">保存済みの解析結果</CardTitle>
          <CardDescription>別の端末で確認済みの結果も開けます。今の下書きとの切替方法は、結果を確認してから選べます。</CardDescription>
          {resultRetentionError ? <p className="text-sm" role="status">{resultRetentionError}</p> : null}
          <Button type="button" variant="outline" disabled={!draftReady || historyLoading} onClick={() => void loadHistory()}>{historyLoading ? "履歴を取得中…" : "保存済みの解析結果を探す"}</Button>
          {historyError ? <p className="text-sm" role="alert">{historyError}</p> : null}
          {historyJobs?.length === 0 ? <p className="text-sm">保存済みの解析結果はありません。</p> : null}
          {historyJobs?.map((job) => (
            <div key={job.id} className="rounded border p-3 text-sm">
              <p>{job.site_name || "現場名なし"}（{new Date(job.created_at).toLocaleString("ja-JP")}）</p>
              <Button type="button" variant="outline" disabled={isAnalyzing || analysisBlocksIntake(jobAccepted)} aria-label={`保存済み「${job.site_name || "現場名なし"}」の結果を確認`} onClick={() => {
                analysisSelectionVersionRef.current++; setJobUi(null); setError(null);
                setJobAccepted({ jobId: job.id, backgroundReady: false, status: "done" });
                setExplicitSelectionEpoch((current) => current + 1);
              }}>結果を確認</Button>
            </div>
          ))}
          {historyNext ? <Button type="button" variant="outline" disabled={historyLoading} onClick={() => void loadHistory(historyNext)}>さらに前の結果を探す</Button> : null}
        </CardHeader>
      </Card>

      {workspaceArchives.length ? (
        <Card>
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">退避した下書き</CardTitle>
            <CardDescription>後回しにした解析結果もここから開けます。復元するときも今の下書きを先に退避します。書き出したデータは端末で保管できます。</CardDescription>
            <details>
              <summary className="cursor-pointer text-sm font-medium">退避した下書きを確認（{workspaceArchives.length}件）</summary>
              <div className="mt-3 space-y-3">
                {workspaceArchives.map((archive, index) => (
                  <div key={archive.key} className="rounded border p-3 text-sm">
                    <p>{index + 1}. {archive.draft?.siteName || "現場名なし"}（解析{archive.draft?.parsed?.items.length ?? 0}品番・発注下書き{archive.draft?.orderDraftItems.length ?? 0}件）</p>
                    <p className="mt-1 text-muted-foreground">{describeMemo(archive.draft?.parsed ?? null)}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" aria-label={`退避${index + 1}「${archive.draft?.siteName || "現場名なし"}」を書き出す`} onClick={() => downloadWorkspace(archive.raw)}>書き出す</Button>
                      <Button type="button" variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal py-2" disabled={!archive.draft} aria-label={`退避${index + 1}「${archive.draft?.siteName || "現場名なし"}」を復元`} onClick={() => {
                        if (!archive.draft) return;
                        try {
                          safelySwitchWorkspace(archive.draft); setResultChoiceDeferred(true);
                          try { localStorage.removeItem(`sokupa:lastJobId:${lineUserId}`); localStorage.removeItem("sokupa:lastJobId"); } catch { /* Server results remain retained. */ }
                        } catch (error) { setError(`今の下書きを保持しています。復元できませんでした。 ${getErrorDetail(error)}`); }
                      }}>今の下書きを退避して復元</Button>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </CardHeader>
        </Card>
      ) : null}

      {draftRecovery ? (
        <Card className="border-amber-500/50">
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">保存した下書きの復元が必要です</CardTitle>
            <CardDescription>元の保存データは保持しています。書き出すか、元データを端末内の別の場所へ退避して新しく始められます。</CardDescription>
            <Button type="button" variant="outline" onClick={() => {
              const url = URL.createObjectURL(new Blob([draftRecovery.raw], { type: "application/json" }));
              const anchor = document.createElement("a"); anchor.href = url; anchor.download = "sokupa-draft-recovery.json"; anchor.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}>保存データをダウンロード</Button>
            <Button type="button" onClick={() => {
              try {
                archiveWorkspaceDraft(localStorage, draftRecovery.key, draftRecovery.raw, crypto.randomUUID());
                setSiteName(""); setParsed(null); setOriginalParsed(null); setOrderDraftItems([]);
                setResultJobId(null); appliedJobRef.current = null; restoredDraftRef.current = null;
                persistedWorkspaceRef.current = draftRecovery.raw;
                setWorkspaceArchives(listWorkspaceArchives(localStorage, draftRecovery.key));
                setDraftRecovery(null); setError(null); setDraftReady(true);
              } catch (error) { setError(`元データを退避できませんでした。書き出して保管してください。 ${getErrorDetail(error)}`); }
            }}>元データを退避して新しく始める</Button>
          </CardHeader>
        </Card>
      ) : null}

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
            <CardTitle className="text-base">{jobAccepted.status === "done" || jobUi?.status === "done" ? "解析が完了しました" : "解析を受け付けました"}</CardTitle>
            <CardDescription>
              {jobAccepted.status === "done" && !jobUi ? "結果を確認しています。新しい解析も開始できます。" : jobUi?.status === "done" ? pendingJobResult?.jobId === jobAccepted.jobId ? "別の解析結果は保存されています。切替方法を選べます。LINE通知も再確認しています。" : "LINE通知を再確認しています。解析結果はこの画面で利用できます。" : jobAccepted.backgroundReady ? "サーバー側で解析を続けています。スマホを閉じても、完了後にLINEで通知します。" : "解析は保存されています。サーバーの処理再開を待っています。画面を閉じてもデータは失われません。"}
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
            image_needs_review: prev?.image_needs_review,
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
