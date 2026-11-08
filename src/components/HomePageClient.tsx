"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";

import { LineNotificationEntry } from "@/components/LineNotificationEntry";
import { WorkspaceModeMenu, type CalculationMode } from "@/components/WorkspaceModeMenu";
import { AreaCalculator } from "@/components/AreaCalculator";
import { OrderDraftList, type PendingOrderDraftDuplicate } from "@/components/OrderDraftList";
import { OrderList } from "@/components/OrderList";
import { EmptyResultWorkspace } from "@/components/EmptyResultWorkspace";
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
import { readWorkspaceDraft, archiveWorkspaceDraft, workspaceContainsJobResult, workspaceWouldBeReplacedByResult, listWorkspaceArchives, switchWorkspaceDraft, replaceWorkspaceDraft, retainDeferredJobResult, type ResultSession, type WorkspaceArchive, type WorkspaceDraft } from "@/lib/workspace-draft";
import { activateResultSession, allowResultJob, commitResultTransition, hasUnfinishedResultInput, isObservationOnlyChange, resetResultDraft, restoreResultDraft, resultAgePolicy, resultMayApply, resumeResultDraft, stampResultSession } from "@/lib/result-session";
import { workspaceFingerprint, readReplacementConsent, writeReplacementConsent, forgetReplacementConsent, type ReplacementConsent } from "@/lib/replacement-consent";
import { withWorkspaceLock, saveLatestWorkspaceSnapshot, restoreLatestWorkspaceSnapshot, rebuildLatestWorkspaceSnapshot } from "@/lib/latest-workspace";
import { notificationRetryable, analysisBlocksIntake, mergeNotificationWatch, forgetJobPointerIfMatches, needsAnalysisRestoration, type NotificationWatch } from "@/lib/notification-watch";
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

export default function HomePageClient({ basicView = false }: { basicView?: boolean }) {
  const [resultWorkspaceView, setResultWorkspaceView] = useState<"quantity" | "edit" | "photo">("quantity");
  const uploadInputId = useId();
  const siteNameId = useId();
  const [siteName, setSiteName] = useState("");
  const [resultSiteName, setResultSiteName] = useState("");
  const [resultSession, setResultSession] = useState<ResultSession>();
  const [resultBootPending, setResultBootPending] = useState(true);
  const [resultActionBusy, setResultActionBusy] = useState(false);
  const resultActionRef = useRef(false);
  const editorBlockedRef = useRef(false);
  const externalWorkspaceRef = useRef(false);
  const meaningfulEditRef = useRef(0), meaningfulSavedRef = useRef(0);
  const noteResultEdit = useCallback(() => { meaningfulEditRef.current++; }, []);
  const reportEditorBlocked = useCallback((blocked: boolean) => { editorBlockedRef.current = blocked; }, []);
  const [recoverySettled, setRecoverySettled] = useState(false);
  const recoveryActiveRef = useRef(false), recoveryFailedRef = useRef(false);
  const [recoveryFlags, setRecoveryFlags] = useState({ active: false, failed: false });
  const resultWorkedRef = useRef(false);
  const [resultEntry, setResultEntry] = useState(0);
  const evaluatedEntryRef = useRef(-1);
  const mountedResultRef = useRef(true);
  useEffect(() => { mountedResultRef.current = true; return () => { mountedResultRef.current = false; }; }, []);
  const [qaSynthetic, setQaSynthetic] = useState(false);
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const intakeInFlightRef = useRef(false);
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
  const acceptedReplacementRef = useRef<ReplacementConsent | null>(null);
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">("saving");
  const [latestRecoveryCandidate, setLatestRecoveryCandidate] = useState<WorkspaceDraft | null>(null);
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
  const historyPanelRef = useRef<HTMLDetailsElement>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [resultRetentionError, setResultRetentionError] = useState<string | null>(null);
  useEffect(() => { if ((historyError || resultRetentionError) && historyPanelRef.current) historyPanelRef.current.open = true; }, [historyError, resultRetentionError]);
  const [resultJobId, setResultJobId] = useState<string | null>(null);
  const [memoInputOpen, setMemoInputOpen] = useState(false);
  const hasResult = Boolean(parsed?.items.length);
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
        setQaSynthetic(Boolean(session.qa?.synthetic));
        const key = `sokupa:workspace:v1:${session.line_user_id}`;
        const saved = localStorage.getItem(key);
        try { acceptedReplacementRef.current = readReplacementConsent(localStorage, session.line_user_id); } catch { /* Server discovery still retains the job. */ }
        let latest: WorkspaceDraft | null = null;
        try { latest = await withWorkspaceLock(key, () => restoreLatestWorkspaceSnapshot(localStorage, session.line_user_id)); }
        catch { setSaveState("error"); }
        if (cancelled) return;
        setLatestRecoveryCandidate(latest);
        persistedWorkspaceRef.current = saved;
        setWorkspaceArchives(listWorkspaceArchives(localStorage, `sokupa:workspace:v1:${session.line_user_id}`));
        if (saved || latest) {
          let draft;
          try { draft = saved ? readWorkspaceDraft(saved) : latest!; }
          catch (error) { if (saved !== null) setDraftRecovery({ key: `sokupa:workspace:v1:${session.line_user_id}`, raw: saved }); throw error; }
          restoredDraftRef.current = draft;
          appliedJobRef.current = draft.parsed ? draft.resultJobId ?? null : null;
          setResultJobId(appliedJobRef.current);
          setResultSiteName(draft.resultSiteName ?? draft.siteName);
          setResultSession(draft.resultSession);
          setSiteName(typeof draft.siteName === "string" ? draft.siteName : "");
          setMemoInputOpen(false); setParsed(draft.parsed);
          setOriginalParsed(draft.originalParsed ?? draft.parsed);
          setOrderDraftItems(draft.orderDraftItems);
          if (!draft.parsed || ["show", "inactive"].includes(resultAgePolicy(draft.resultSession, Date.now()))) setResultBootPending(false);
        }
        if (!saved && !latest) setResultBootPending(false);
        setDraftReady(true);
      } catch (error) { if (!cancelled) setError(getErrorDetail(error)); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (draftReady) currentWorkspaceRef.current = { version: 1, siteName, parsed, originalParsed, orderDraftItems, resultJobId, resultSiteName, resultSession };
  }, [draftReady, siteName, parsed, originalParsed, orderDraftItems, resultJobId, resultSiteName, resultSession]);

  useEffect(() => {
    if (!draftReady || !lineUserId || resultBootPending) return;
    const key = `sokupa:workspace:v1:${lineUserId}`;
    const draft: WorkspaceDraft = { version: 1, siteName, parsed, originalParsed, orderDraftItems, resultJobId, resultSiteName, resultSession };
    const serialized = JSON.stringify(draft);
    const editVersion = meaningfulEditRef.current;
    queueMicrotask(() => { if (JSON.stringify(currentWorkspaceRef.current) === serialized) setSaveState("saving"); });
    void withWorkspaceLock(key, async () => {
      // A queued old render must not save after a newer edit or an explicit result selection.
      if (JSON.stringify(currentWorkspaceRef.current) !== serialized) return;
      if (localStorage.getItem(key) !== persistedWorkspaceRef.current) throw new Error("Workspace changed in another tab");
      const next = await stampResultSession(draft, Date.now(), editVersion > meaningfulSavedRef.current);
      if (JSON.stringify(currentWorkspaceRef.current) !== serialized) return;
      const nextRaw = JSON.stringify(next); readWorkspaceDraft(nextRaw);
      localStorage.setItem(key, nextRaw);
      if (localStorage.getItem(key) !== nextRaw) throw new Error("Draft persistence failed");
      persistedWorkspaceRef.current = nextRaw; currentWorkspaceRef.current = next;
      if (JSON.stringify(next.resultSession) !== JSON.stringify(resultSession)) setResultSession(next.resultSession);
      await saveLatestWorkspaceSnapshot(localStorage, lineUserId, next);
      meaningfulSavedRef.current = editVersion;
      if (parsed && resultJobId) forgetReplacementConsent(localStorage, lineUserId, resultJobId);
      if (JSON.stringify(currentWorkspaceRef.current) === nextRaw) setSaveState("saved");
      if (parsed && resultJobId) void fetch(`/api/analysis-jobs/${encodeURIComponent(resultJobId)}/seen`, { method: "POST" }).catch(() => undefined);
    }).catch(() => { setSaveState("error"); setError("端末への下書き保存に失敗しました。必要な内容を書き出して保存してください。別のタブで更新した場合は再読み込みしてください。"); });
  }, [draftReady, lineUserId, siteName, parsed, originalParsed, orderDraftItems, resultJobId, resultSiteName, resultSession, resultBootPending]);

  const downloadWorkspace = (raw: string) => {
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "sokupa-workspace.json"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const safelySwitchWorkspace = async (next: WorkspaceDraft, archive = true) => {
    if (!lineUserId || !currentWorkspaceRef.current) throw new Error("下書きの準備ができていません。");
    const key = `sokupa:workspace:v1:${lineUserId}`, current = currentWorkspaceRef.current;
    next = { ...next, resultSiteName: next.resultSiteName ?? next.siteName, resultSession: activateResultSession(current.resultSession) };
    const snapshot = JSON.stringify(current), expected = persistedWorkspaceRef.current, nextRaw = JSON.stringify(next);
    let attempt = switchAttemptRef.current;
    if (!attempt || attempt.snapshot !== snapshot || attempt.expected !== expected || attempt.next !== nextRaw) {
      attempt = { snapshot, expected, next: nextRaw, suffix: `${Date.now()}-${crypto.randomUUID()}` }; switchAttemptRef.current = attempt;
    }
    const suffix = attempt.suffix;
    const switched = await withWorkspaceLock(key, async () => {
      if (JSON.stringify(currentWorkspaceRef.current) !== snapshot) throw new Error("切替を待つ間に編集されました。もう一度確認してください。");
      const result = archive ? switchWorkspaceDraft(localStorage, key, expected, current, next, suffix) : replaceWorkspaceDraft(localStorage, key, expected, next);
      try { await saveLatestWorkspaceSnapshot(localStorage, lineUserId, next); } catch { setSaveState("error"); }
      return result;
    });
    analysisSelectionVersionRef.current++;
    persistedWorkspaceRef.current = switched.raw; currentWorkspaceRef.current = next;
    appliedJobRef.current = next.parsed ? next.resultJobId ?? null : null; restoredDraftRef.current = next;
    setResultSiteName(next.resultSiteName ?? next.siteName); setResultSession(next.resultSession);
    noteResultEdit();
    setSiteName(next.siteName); setParsed(next.parsed); setOriginalParsed(next.originalParsed ?? next.parsed);
    setOrderDraftItems(next.orderDraftItems); setResultJobId(next.resultJobId ?? null); setCalculationMode("dimensions"); setMemoInputOpen(false);
    setJobAccepted(null); setJobUi(null); setError(null);
    try { setWorkspaceArchives(listWorkspaceArchives(localStorage, key)); }
    catch { setWorkspaceArchives((previous) => [...switched.archives, ...previous.filter((entry) => !switched.archives.some((saved) => saved.key === entry.key))]); }
  };

  useEffect(() => {
    if (!lineUserId) return;
    const listener = (event: StorageEvent) => {
      if (event.key !== `sokupa:workspace:v1:${lineUserId}`) return;
      const nextRaw = localStorage.getItem(event.key);
      if (nextRaw === persistedWorkspaceRef.current) return;
      if (isObservationOnlyChange(persistedWorkspaceRef.current, nextRaw)) {
        const observedAt = readWorkspaceDraft(nextRaw!).resultSession!.observedAt;
        persistedWorkspaceRef.current = nextRaw;
        const current = currentWorkspaceRef.current;
        if (current?.resultSession) currentWorkspaceRef.current = { ...current, resultSession: { ...current.resultSession, observedAt } };
        setResultSession(previous => previous ? { ...previous, observedAt } : previous);
        return;
      }
      externalWorkspaceRef.current = true;
      setSaveState("error"); setError("別の画面で保存内容が変わりました。今の入力は保持しています。書き出すか、再読み込みしてください。");
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [lineUserId]);

  const resultActionBlocked = isAnalyzing || analysisBlocksIntake(jobAccepted) || recoveryFlags.active || resultActionBusy || saveState !== "saved" || !recoverySettled || recoveryFlags.failed || hasUnfinishedResultInput({ parsed });
  const changeResultDisplay = async (kind: "manual" | "restore" | "age" | "declined" | "resume", expectedItems?: string) => {
    if (resultActionRef.current || !lineUserId || !currentWorkspaceRef.current) return;
    const current = currentWorkspaceRef.current, raw = JSON.stringify(current), expected = persistedWorkspaceRef.current;
    if (externalWorkspaceRef.current || isAnalyzing || intakeInFlightRef.current || analysisBlocksIntake(jobAccepted) || recoveryActiveRef.current || recoveryFailedRef.current || editorBlockedRef.current || hasUnfinishedResultInput(current) || saveState === "error") throw new Error("入力・解析・保存の完了を確認してから操作してください。現在の内容は保持しています。");
    if (expectedItems && JSON.stringify(current.parsed?.items) !== expectedItems) throw new Error("編集の保存を待ってから、もう一度操作してください。");
    resultActionRef.current = true; setResultActionBusy(true);
    try {
      if (kind === "manual" && !window.confirm(`現在の結果表示をリセットしますか？\n対象：${(current.resultSiteName ?? current.siteName) || "現場名なし"}・${current.parsed?.items.length ?? 0}品番\n編集済みの結果を端末に1件残します${current.resultSession?.undo ? "（前の戻す用保存は今回の結果に置き換わります）" : ""}。\n選択中の写真・次の現場名・発注リスト・クラウドの履歴や写真は残ります。`)) return;
      const response = await fetch("/api/auth/session", { cache: "no-store" }); const auth = await response.json();
      if (!mountedResultRef.current || !response.ok || !auth.authenticated || auth.line_user_id !== lineUserId) throw new Error("ログイン情報が変わりました。現在の内容を保持して操作を止めました。");
      const jobsResponse = await fetch("/api/analysis-jobs", { cache: "no-store" }); const jobs = await jobsResponse.json();
      if (!jobsResponse.ok || !Array.isArray(jobs.data) || jobs.data.some((job: {status:string}) => ["queued", "running"].includes(job.status))) throw new Error("解析中、または解析状態を確認できないため、現在の結果は保持しています。");
      const next = kind === "restore" ? await restoreResultDraft(current, Date.now()) : kind === "resume" ? await resumeResultDraft(current, Date.now()) : resetResultDraft(current, Date.now(), kind);
      const nextRaw = await withWorkspaceLock(`sokupa:workspace:v1:${lineUserId}`, async () => {
        if (!mountedResultRef.current || JSON.stringify(currentWorkspaceRef.current) !== raw || externalWorkspaceRef.current || editorBlockedRef.current || intakeInFlightRef.current) throw new Error("確認中に内容が変わりました。画面は変更していません。");
        return commitResultTransition(localStorage, lineUserId, expected, next);
      });
      analysisSelectionVersionRef.current++;
      persistedWorkspaceRef.current = nextRaw; currentWorkspaceRef.current = next; restoredDraftRef.current = next;
      appliedJobRef.current = next.resultJobId ?? null; acceptedReplacementRef.current = null;
      setParsed(next.parsed); setOriginalParsed(next.originalParsed ?? next.parsed); setResultJobId(next.resultJobId ?? null);
      setResultSiteName(next.resultSiteName ?? ""); setResultSession(next.resultSession); setCalculationMode("dimensions");
      setJobAccepted(null); setJobUi(null); setError(null); setSaveState("saved"); setResultBootPending(false);
      setAnalysisRecoveryEpoch(value => value + 1);
    } catch (error) { setSaveState("error"); throw error; }
    finally { resultActionRef.current = false; setResultActionBusy(false); }
  };

  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") setResultEntry(value => value + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);

  const retainPendingResult = async (pending: NonNullable<typeof pendingJobResult>) => {
    if (!lineUserId) throw new Error("ログイン情報を確認できません。");
    const key = `sokupa:workspace:v1:${lineUserId}`;
    const archive = await withWorkspaceLock(key, () => retainDeferredJobResult(localStorage, key, pending.jobId, pending.siteName, pending.result));
    setWorkspaceArchives((previous) => [archive, ...previous.filter((entry) => entry.key !== archive.key)]);
  };

  const deferPendingJobResult = async () => {
    const pending = pendingJobResultRef.current;
    if (!pending) return;
    try { await retainPendingResult(pending); setResultChoiceDeferred(true); }
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

  const openPendingJobResult = async (overwrite = false) => {
    const pending = pendingJobResultRef.current, current = currentWorkspaceRef.current;
    if (!pending || !current) return;
    try {
      await safelySwitchWorkspace({ ...current, siteName: pending.siteName ?? "", resultSiteName: pending.siteName ?? "", parsed: pending.result, originalParsed: pending.result, resultJobId: pending.jobId }, !overwrite);
      appliedJobRef.current = pending.jobId; restoredDraftRef.current = null;
      if (lineUserId) void withWorkspaceLock(`sokupa:workspace:v1:${lineUserId}`, () => forgetReplacementConsent(localStorage, lineUserId, pending.jobId)).catch(() => undefined);
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
    setMemoInputOpen(true);

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
    if (resultActionRef.current) return;
    if (!draftReady || analysisBlocksIntake(jobAccepted)) return;
    if (intakeInFlightRef.current || isAnalyzing) return;
    if (readyImages.length === 0) return;
    // Claim synchronously, before any lock/upload/digest can yield to another click.
    intakeInFlightRef.current = true;
    const previousAnalysis = jobAccepted, previousUi = jobUi;
    const admissionVersion = ++analysisSelectionVersionRef.current;
    // Replacement consent covers only the workspace visible at the user's click.
    const workspaceAtStart = currentWorkspaceRef.current;
    setIsAnalyzing(true);
    setError(null);
    setProgress({ done: 0, total: readyImages.length });
    setJobAccepted(null);
    setJobUi(null);

    try {
      const replacementFingerprint = workspaceAtStart ? await workspaceFingerprint(workspaceAtStart) : null;
      try { if (pendingJobResultRef.current) await retainPendingResult(pendingJobResultRef.current); }
      catch { setResultRetentionError("別の解析結果を端末へ保管できませんでした。サーバーの「保存済みの解析結果」から開けます。"); }
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

      // A successful new upload is explicit consent to replace the previous latest result.
      // Keep it visible/saved until completion; edits made meanwhile require a separate choice.
      if (replacementFingerprint) {
        const consent = { jobId: String(createJson.job_id), fingerprint: replacementFingerprint };
        acceptedReplacementRef.current = consent;
        try { await withWorkspaceLock(`sokupa:workspace:v1:${lineUserId}`, () => writeReplacementConsent(localStorage, lineUserId!, consent)); }
        catch { setResultRetentionError("切替情報を端末に保存できませんでした。再起動後は保存済みの解析結果から選べます。"); }
      }
      setJobAccepted({ jobId: String(createJson.job_id), backgroundReady: createJson.background_ready === true && ["scheduled", "scheduled-wake"].includes(createJson.execution_mode), status: "queued" });
      setResultSession(previous => allowResultJob(previous, String(createJson.job_id)));
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
      intakeInFlightRef.current = false;
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
      setRecoverySettled(false); recoveryFailedRef.current = false; recoveryActiveRef.current = false;
      let last: string | null = null;
      const resetControl = currentWorkspaceRef.current?.resultSession;
      try { last = resetControl?.inactive ? resetControl.allowedJobId : localStorage.getItem(`sokupa:lastJobId:${lineUserId}`) || localStorage.getItem("sokupa:lastJobId"); } catch { /* Recover from the server. */ }
      try {
        let pointedJob = false;
        if (last) {
          const { data } = await fetchAnalysisJob(last);
          if (data && !cancelled) {
            if (["queued", "running"].includes(data.status) && !data.requires_manual_restart) recoveryActiveRef.current = true;
            if (data.requires_manual_restart || (data.execution_mode === "legacy" && ["queued", "running"].includes(data.status))) {
              if (selectionVersion === analysisSelectionVersionRef.current) setError("以前の未完了解析は保存されています。必要な画像を選んで新しく解析してください。");
            } else pointedJob = needsAnalysisRestoration(data, true) && resultMayApply(currentWorkspaceRef.current?.resultSession, last);
            if (pointedJob && selectionVersion === analysisSelectionVersionRef.current) setJobAccepted((current) => current ?? { jobId: last!, backgroundReady: data.background_ready === true, status: data.status });
            if (data.status === "done" && notificationRetryable(data.notification_status)) trackNotification({ jobId: last, siteName: data.site_name ?? null, status: data.notification_status });
          }
        }
        const response = await fetch("/api/analysis-jobs", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error("前回の解析を確認できませんでした。通信の回復後に再読込してください。");
        const jobs = Array.isArray(payload.data) ? payload.data : [];
        if (cancelled) return;
        if (jobs.some((job: {status:string}) => ["queued", "running"].includes(job.status))) recoveryActiveRef.current = true;
        for (const job of jobs) if (job.status === "done" && notificationRetryable(job.notification_status)) trackNotification({ jobId: job.id, siteName: job.site_name ?? null, status: job.notification_status });
        const found = jobs.find((job: { id:string; status: string; client_result_seen_at?: string | null }) => needsAnalysisRestoration(job) && resultMayApply(currentWorkspaceRef.current?.resultSession, job.id));
        if (!pointedJob && found?.id && selectionVersion === analysisSelectionVersionRef.current) setJobAccepted((current) => current ?? { jobId: found.id, backgroundReady: false, status: found.status });
      } catch { if (!cancelled && selectionVersion === analysisSelectionVersionRef.current) { recoveryFailedRef.current = true; setError("前回の解析を確認できませんでした。通信の回復後に再読込してください。"); } }
      finally { if (!cancelled) { setRecoverySettled(true); setRecoveryFlags({ active: recoveryActiveRef.current, failed: recoveryFailedRef.current }); } }
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
      if (["done", "failed"].includes(status)) { recoveryActiveRef.current = false; setRecoveryFlags(previous => previous.active ? { ...previous, active: false } : previous); }
      const done = Number(data.done_images) || 0, total = Math.max(1, Number(data.total_images) || 1);
      setJobUi({ status, done, total, percent: Math.min(100, Math.max(0, Math.round(done / total * 100))), notificationStatus: data.notification_status });
      if (resultBootPending && status === "done") return;
      if (status === "done" && data.result && appliedJobRef.current !== jobId && !externalWorkspaceRef.current && resultMayApply(currentWorkspaceRef.current?.resultSession, jobId)) {
        const current = currentWorkspaceRef.current;
        let replacement = acceptedReplacementRef.current;
        try { replacement = lineUserId ? readReplacementConsent(localStorage, lineUserId) : null; } catch { /* An in-memory intent can still finish this tab's accepted request. */ }
        const currentRaw = JSON.stringify(current);
        const consentedReplacement = replacement?.jobId === jobId && replacement.fingerprint === await workspaceFingerprint(current);
        if (cancelled || selectionVersion !== analysisSelectionVersionRef.current || JSON.stringify(currentWorkspaceRef.current) !== currentRaw) return;
        if (workspaceWouldBeReplacedByResult(current, jobId, data.site_name ?? null) && !consentedReplacement) {
          if (pendingJobResultRef.current?.jobId !== jobId) setResultChoiceDeferred(false);
          const pending = { jobId, siteName: data.site_name ?? null, result: data.result as ParsedMemoPayload, backgroundReady: data.background_ready === true };
          pendingJobResultRef.current = pending; setPendingJobResult(pending);
        } else {
          const retainEdits = workspaceContainsJobResult(current ?? restoredDraftRef.current, jobId);
          appliedJobRef.current = jobId; setResultJobId(jobId); restoredDraftRef.current = null;
          if (!retainEdits) {
            if (acceptedReplacementRef.current?.jobId === jobId) acceptedReplacementRef.current = null;
            setSiteName(data.site_name ?? "");
            setResultSiteName(data.site_name ?? ""); setResultSession(previous => activateResultSession(previous)); noteResultEdit();
            setMemoInputOpen(false); setParsed(data.result as ParsedMemoPayload); setOriginalParsed(data.result as ParsedMemoPayload);
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
  }, [jobAccepted?.jobId, lineUserId, rememberNotification, trackNotification, analysisRecoveryEpoch, explicitSelectionEpoch, resultBootPending, noteResultEdit]);

  const resultActionCallback = useRef(changeResultDisplay);
  useEffect(() => { resultActionCallback.current = changeResultDisplay; });
  useEffect(() => {
    if (!draftReady || !recoverySettled || evaluatedEntryRef.current === resultEntry) return;
    evaluatedEntryRef.current = resultEntry;
    void (async () => {
      const current = currentWorkspaceRef.current;
      if (!current?.parsed || current.resultSession?.inactive) { setResultBootPending(false); return; }
      if (resultEntry > 0 && resultWorkedRef.current) { setResultBootPending(false); return; }
      if (recoveryActiveRef.current || recoveryFailedRef.current || isAnalyzing || analysisBlocksIntake(jobAccepted) || resultActionRef.current || editorBlockedRef.current || hasUnfinishedResultInput(current) || saveState === "error" || externalWorkspaceRef.current || document.querySelector("dialog[open]") || document.activeElement?.matches("input,textarea,select")) {
        setResultBootPending(false); return;
      }
      const policy = resultAgePolicy(current.resultSession, Date.now());
      try {
        if (policy === "confirm") {
          const accepted = window.confirm(`前回の編集済み結果に戻りますか？\n現場：${(current.resultSiteName ?? current.siteName) || "現場名なし"}\n24時間以上経過、または保存時刻を確認できません。戻さない場合も1件を残し、メモ画像タブから復元できます。`);
          await resultActionCallback.current(accepted ? "resume" : "declined");
        } else if (policy === "hide") await resultActionCallback.current("age");
        else { setResultSession(previous => previous ? { ...previous, observedAt: Date.now() } : previous); setResultBootPending(false); }
      } catch (error) { setError(getErrorDetail(error)); setSaveState("error"); setResultBootPending(false); }
    })();
  }, [draftReady, recoverySettled, resultEntry, isAnalyzing, jobAccepted, saveState]);

  const resultTools = <div className="space-y-3 rounded-xl border bg-background p-3 text-sm" aria-label="前回の結果とリセット">
    {parsed ? <label className="block text-xs font-semibold">この結果の現場名（コピーに使用）<Input className="mt-1 min-h-11" aria-label="表示中の結果の現場名" value={resultSiteName} onChange={event => { noteResultEdit(); setResultSiteName(event.target.value); }} /></label> : null}
    {resultSession?.undo ? <>
      <p>戻せる前回：{resultSession.undo.resultSiteName || "現場名なし"}・{resultSession.undo.parsed.items.length}品番</p>
      <Button type="button" variant="outline" className="min-h-11" data-workspace-navigation disabled={Boolean(parsed) || resultActionBlocked} onClick={() => void changeResultDisplay("restore").catch(error => setError(getErrorDetail(error)))}>前回の結果だけ戻す</Button>
      <p className="text-xs text-muted-foreground">1件まで。戻すと枠は空になります。次の写真・現場名と発注リストはそのままです。{parsed ? "現在の結果がある間は戻せません。" : ""}</p>
    </> : <p className="text-xs text-muted-foreground">戻す用の保存はありません。リセット時に直前の1件を残します。</p>}
    {resultSession?.inactive ? <p className="text-xs">{resultSession.reason === "age" ? "48時間以上経過したため、結果表示を片付けました。" : "結果表示はリセットされています。"}履歴やクラウドの写真は削除していません。</p> : null}
  </div>;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-3 px-2 py-4 sm:gap-4 sm:px-4 sm:py-6 md:px-6 lg:px-8" onPointerDownCapture={() => { resultWorkedRef.current = true; }} onKeyDownCapture={() => { resultWorkedRef.current = true; }}>
      {basicView ? <p role="status" className="rounded-xl border border-amber-500/40 p-3 text-sm">基本表示中です。解析・編集・保存・発注の基本機能を使えます。数量は元メモと照合してください。</p> : null}
      <header className="flex items-center justify-between gap-3 pb-1">
        <div className="min-w-0">{/* eslint-disable-next-line @next/next/no-img-element */}
        <h1 className="w-[120px] max-w-[46vw] rounded-md bg-white px-1 py-2"><img src="/sokupa-header-logo-small-wordmark.webp" alt="ソクパ SOKUPA" width={405} height={80} className="block h-auto w-full" /></h1>
          {parsed && resultSiteName ? <p className="truncate text-xs text-muted-foreground">{resultSiteName}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-[13px]">{!qaSynthetic ? <LineNotificationEntry /> : null}
        <WorkspaceModeMenu help={<p>メモ画像の寸法を読み取り、必要量に予備分{DEFAULT_LOSS_RATE_PERCENT}%を加えて発注数量を計算します。予備分は変更できます。</p>} value={calculationMode} count={orderDraftItems.length} onChange={mode => {
          if (mode === "area") setAreaCalculatorMounted(true);
          setCalculationMode(mode);
          window.scrollTo({ top: 0, behavior: "instant" });
        }} />
        </div>
      </header>


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
        role="region"
        aria-label="メモ計測"
        hidden={calculationMode !== "dimensions"}
        className="space-y-6 sm:space-y-8"
      >

      <details hidden={resultWorkspaceView !== "quantity"} data-workspace-overview="input" open={!hasResult || memoInputOpen} onToggle={event => { if (hasResult) setMemoInputOpen(event.currentTarget.open); }} className="text-sm">
        <summary className="min-h-8 cursor-pointer font-semibold">画像・現場名{images.length ? `（選択中${images.length}枚）` : ""}</summary>
      <div className="mt-3 space-y-5">
        <div>
          <label htmlFor={siteNameId} className="mb-1 block text-sm font-medium">
            {parsed ? "次の解析の現場名（任意）" : "現場名（任意）"}
          </label>
          <Input
            id={siteNameId}
            aria-label="現場名（任意）"
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="例: 渋谷区〇〇マンション リビング"
            className="rounded-lg px-4 py-2 focus-visible:ring-black"
          />
          {parsed ? <p className="mt-1 text-xs text-muted-foreground">表示中の結果：{resultSiteName || "現場名なし"}。結果の現場名はメモ画像タブで変更できます。</p> : null}
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
                  解析中... {progress ? `${progress.done}/${progress.total}` : ""}（{qaSynthetic ? "合成通知の受付を確認します" : "完了後にLINEで通知します"}）
                </span>
              </span>
            </span>
          ) : (
            `${images.length}枚の画像を解析する`
          )}
        </Button>

      </div>
      </details>
      </section>

      {notificationWatches.length ? (
        <Card>
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">{qaSynthetic ? "合成通知（LINE送信なし）" : "LINE通知"}</CardTitle>
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
                <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal py-2" onClick={() => void openPendingJobResult(true)}>最新1件に上書きして開く（今の結果と置換）</Button>
                <Button type="button" className="h-auto min-h-10 max-w-full whitespace-normal py-2" onClick={() => void openPendingJobResult()}>今の下書きを退避して別の結果を開く</Button>
              </>
            )}
            <Button type="button" variant="outline" onClick={() => { if (currentWorkspaceRef.current) downloadWorkspace(JSON.stringify(currentWorkspaceRef.current)); }}>今の下書きを書き出す</Button>
            <Button type="button" variant="outline" onClick={() => downloadWorkspace(JSON.stringify({ version: 1, siteName: pendingJobResult.siteName ?? "", parsed: pendingJobResult.result, originalParsed: pendingJobResult.result, orderDraftItems: [], resultJobId: pendingJobResult.jobId }))}>別の解析結果を書き出す</Button>
            {resultChoiceDeferred ? <p className="text-sm text-muted-foreground">後回しにした結果は「退避した下書き」からも開けます。</p> : null}
          </CardHeader>
        </Card>
      ) : null}

      <details hidden={resultWorkspaceView !== "quantity"} data-workspace-overview="history" ref={historyPanelRef} className="text-sm">
        <summary className="min-h-8 cursor-pointer text-sm font-semibold">保存済みの結果を開く</summary>
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
                analysisSelectionVersionRef.current++; setJobUi(null); setError(null); setCalculationMode("dimensions");
                setResultSession(previous => allowResultJob(previous, job.id));
                setJobAccepted({ jobId: job.id, backgroundReady: false, status: "done" });
                setExplicitSelectionEpoch((current) => current + 1);
              }}>結果を確認</Button>
            </div>
          ))}
          {historyNext ? <Button type="button" variant="outline" disabled={historyLoading} onClick={() => void loadHistory(historyNext)}>さらに前の結果を探す</Button> : null}
        </CardHeader>
      </Card>

      </details>

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
                      <Button type="button" variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal py-2" disabled={!archive.draft} aria-label={`退避${index + 1}「${archive.draft?.siteName || "現場名なし"}」を復元`} onClick={async () => {
                        if (!archive.draft) return;
                        try {
                          await safelySwitchWorkspace(archive.draft); setResultChoiceDeferred(true);
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
            {latestRecoveryCandidate ? <Button type="button" variant="outline" onClick={async () => {
              try {
                await withWorkspaceLock(draftRecovery.key, () => archiveWorkspaceDraft(localStorage, draftRecovery.key, draftRecovery.raw, crypto.randomUUID()));
                const next = latestRecoveryCandidate;
                persistedWorkspaceRef.current = draftRecovery.raw; currentWorkspaceRef.current = next; restoredDraftRef.current = next;
                appliedJobRef.current = next.resultJobId ?? null;
                setSiteName(next.siteName); setParsed(next.parsed); setOriginalParsed(next.originalParsed ?? next.parsed); setOrderDraftItems(next.orderDraftItems); setResultJobId(next.resultJobId ?? null); setCalculationMode("dimensions"); setMemoInputOpen(false);
                setResultSiteName(next.resultSiteName ?? next.siteName); setResultSession(next.resultSession);
                setDraftRecovery(null); setDraftReady(true); setError(null);
              } catch { setError("元データを保全できなかったため復元を止めました。書き出して保管してください。"); }
            }}>最新の保存結果から復元（元データは退避）</Button> : null}
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
                setResultSiteName(""); setResultSession(undefined);
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
              {jobAccepted.status === "done" && !jobUi ? "結果を確認しています。新しい解析も開始できます。" : jobUi?.status === "done" ? pendingJobResult?.jobId === jobAccepted.jobId ? "別の解析結果は保存されています。切替方法を選べます。LINE通知も再確認しています。" : "LINE通知を再確認しています。解析結果はこの画面で利用できます。" : jobAccepted.backgroundReady ? qaSynthetic ? "サーバー側で合成解析を続けています。画面を閉じても処理を続け、合成通知を記録します（LINE送信なし）。" : "サーバー側で解析を続けています。スマホを閉じても、完了後にLINEで通知します。" : "解析は保存されています。サーバーの処理再開を待っています。画面を閉じてもデータは失われません。"}
              {jobUi ? (
                <span className="mt-2 block font-semibold text-emerald-800/90 dark:text-emerald-200">
                  {jobUi.percent}% 完了（{jobUi.done}/{jobUi.total}）
                </span>
              ) : null}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <p role="status" aria-label="結果の保存状態" className={`my-1 text-xs ${saveState === "error" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"}`}>
        {saveState === "saving" ? "最新結果と編集を保存中…" : saveState === "error" ? "保存を確認できません。内容を書き出して保管してください。" : parsed ? "最新結果・編集を端末に保存済み" : "入力内容を端末に保存済み。"}
      </p>
      {saveState === "error" ? <div className="mb-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => { if (currentWorkspaceRef.current) downloadWorkspace(JSON.stringify(currentWorkspaceRef.current)); }}>保存できない現在の内容を書き出す</Button>
        <Button type="button" variant="outline" disabled={!draftReady || !parsed} onClick={async () => {
          if (!lineUserId || !currentWorkspaceRef.current) return;
          const key = `sokupa:workspace:v1:${lineUserId}`, current = currentWorkspaceRef.current, raw = JSON.stringify(current);
          try {
            await withWorkspaceLock(key, async () => {
              if (localStorage.getItem(key) !== raw || JSON.stringify(currentWorkspaceRef.current) !== raw) throw new Error("別の画面の更新を先に確認してください。");
              await rebuildLatestWorkspaceSnapshot(localStorage, lineUserId, current);
            });
            setSaveState("saved"); setError(null);
          } catch (error) { setError(getErrorDetail(error)); }
        }}>復元用保存を再作成（元の保存は退避）</Button>
      </div> : null}
      {parsed && analysisBlocksIntake(jobAccepted) ? <p className="mb-3 text-sm">前回の結果を表示しています。新しい解析はサーバー側で処理中です。</p> : null}
      <section aria-label="メモの解析結果" hidden={calculationMode !== "dimensions"}>
      {resultBootPending ? <p role="status">前回の結果と保存時刻を確認しています…</p> : <>
      {!parsed ? <EmptyResultWorkspace tools={resultTools} onWorkspaceViewChange={setResultWorkspaceView} /> : null}
      <OrderList
        key={resultJobId ?? "legacy-workspace"}
        items={parsed?.items ?? []}
        sourceItems={originalParsed?.items}
        sourceJobId={basicView ? null : resultJobId}
        readingReviewSourceJobId={resultJobId}
        basicView={basicView}
        notes={parsed?.notes}
        siteName={resultSiteName}
        resultTools={resultTools}
        onWorkspaceViewChange={setResultWorkspaceView}
        onMeaningfulEdit={noteResultEdit}
        onEditorBlocked={reportEditorBlocked}
        resetDisabledReason={resultActionBlocked ? "解析・入力・保存の完了後にリセットできます。" : undefined}
        onResetResult={expected => changeResultDisplay("manual", expected).catch(error => setError(getErrorDetail(error)))}
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
      </>}
      </section>

      {areaCalculatorMounted ? (
        <section id="area-calculator-panel" role="region" aria-label="実寸計測（㎡から計算）" hidden={calculationMode !== "area"}>
          <AreaCalculator onAddToOrderDraft={requestAddToOrderDraft} />
        </section>
      ) : null}

      <section id="order-draft-panel" role="region" aria-label="発注下書き" hidden={calculationMode !== "order-draft"}>
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
