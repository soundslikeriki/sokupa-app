import { getDeadline } from "@vercel/functions";

/** One monotonic clock from HTTP entry, shared by every continuation in that invocation. */
export class AnalysisBudget {
  private readonly started: number;
  private readonly duration: number;
  constructor(private readonly now: () => number = () => performance.now(), invocationDeadline = getDeadline(), wallNow = Date.now()) {
    this.started = now();
    const platformRemaining = invocationDeadline ? invocationDeadline.getTime() - wallNow : 300_000;
    this.duration = Number.isFinite(platformRemaining) ? Math.max(0, Math.min(300_000, platformRemaining)) : 300_000;
  }
  remaining(deadline = 240_000): number {
    // Preserve the same closing reserve even when cold initialization/auth consumed time
    // before this handler, or the platform supplies an earlier shared deadline.
    return Math.max(0, Math.min(deadline, this.duration - (300_000 - deadline)) - (this.now() - this.started));
  }
  providerSignal(kind: "vision" | "catalog"): AbortSignal {
    const available = this.remaining();
    const minimum = kind === "vision" ? 150_000 : 90_000;
    if (available < minimum) throw new AnalysisYield();
    return AbortSignal.timeout(Math.floor(Math.min(available, kind === "vision" ? 210_000 : 90_000)));
  }
  /** DB, storage, LINE and worker completion also share the absolute closing deadline. */
  fetch(fetcher: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      const remaining = Math.floor(this.remaining(285_000));
      if (remaining <= 0) throw new AnalysisYield();
      const signal = AbortSignal.timeout(Math.min(15_000, remaining));
      const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetcher(input, { ...init, signal: upstream ? AbortSignal.any([upstream, signal]) : signal });
    };
  }
}
export class AnalysisYield extends Error { constructor() { super("Invocation budget reserved for persistence and completion"); } }
export class AnalysisCheckpointError extends Error { constructor() { super("Durable provider checkpoint unavailable; no provider replay"); } }
