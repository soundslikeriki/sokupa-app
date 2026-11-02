export type AnalysisFailureCode = "rate_limit" | "upstream_unavailable" | "authentication" | "configuration" | "network" | "timeout" | "content";
export type ParseFailure = { kind: "infrastructure" | "content"; code: AnalysisFailureCode; retryable: boolean; delivery_unknown: boolean; retry_after_seconds?: number };

/** Provider errors must never be flattened into an unreadable-image error or expose SDK messages. */
export class MemoProviderError extends Error {
  constructor(readonly failure: ParseFailure, readonly upstreamStatus?: number) {
    super(failure.code === "authentication" || failure.code === "configuration" ? "解析サービスの設定を確認する必要があります。" : failure.delivery_unknown ? "解析サービスへの通信結果を確認できませんでした。自動再試行は停止しました。" : failure.retryable ? "解析サービスが一時的に利用できません。待ち時間を置いて再試行します。" : "解析サービスが利用できないため自動再試行を停止しました。");
  }
}

export function providerError(error: unknown, timedOut=false): MemoProviderError {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : undefined;
  const name = typeof value.name === "string" ? value.name : "";
  if (timedOut || /Abort|Timeout/.test(name) || status === 408 || status === 504) return new MemoProviderError({kind:"infrastructure",code:"timeout",retryable:false,delivery_unknown:true},status);
  if (status === 429 || (status !== undefined && status >= 500)) {
    const details = Array.isArray(value.errorDetails) ? value.errorDetails : [];
    const retry = details.find(detail => detail && typeof detail === "object" && String(detail["@type"]).endsWith("google.rpc.RetryInfo"));
    const raw = retry?.retryDelay;
    const seconds = typeof raw === "string" && /^\d+(?:\.\d+)?s$/.test(raw) ? Math.ceil(Number(raw.slice(0,-1))) : 0;
    return new MemoProviderError({kind:"infrastructure",code:status===429?"rate_limit":"upstream_unavailable",retryable:seconds<=900,delivery_unknown:false,...(seconds>0&&seconds<=900?{retry_after_seconds:seconds}:{})},status);
  }
  if (status !== undefined) return new MemoProviderError({kind:"infrastructure",code:[401,403].includes(status)?"authentication":"configuration",retryable:false,delivery_unknown:false},status);
  // SDKs can erase the original network error type. Unknown outcomes are never retried blindly.
  return new MemoProviderError({kind:"infrastructure",code:"network",retryable:false,delivery_unknown:true});
}

export function isInfrastructureParseFailure(value: unknown): value is ParseFailure {
  return Boolean(value && typeof value === "object" && (value as ParseFailure).kind === "infrastructure");
}
