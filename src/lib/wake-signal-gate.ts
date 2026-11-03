/** Soft burst control per warm process. It does not replace platform-wide rate limiting. */
export function createWakeSignalGate(clock: () => number = () => performance.now()) {
  let inFlight = false, nextLookupAt = -Infinity;
  return {
    begin(): boolean {
      const now = clock();
      if (inFlight || now < nextLookupAt) return false;
      inFlight = true; nextLookupAt = now + 5_000;
      return true;
    },
    finish(): void { inFlight = false; },
  };
}
