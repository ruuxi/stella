export function isRetryableModelError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase() ?? "";
  if (message.length === 0) return false;
  if (message.includes("aborted") || message.includes("context length")) {
    return false;
  }
  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("invalid api key") ||
    message.includes("authentication") ||
    message.includes("model not found") ||
    message.includes("temporarily unavailable") ||
    message.includes("upstream")
  );
}

export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
