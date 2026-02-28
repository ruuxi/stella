import {
  isAbortError,
  isContextOverflowError,
  matchesRetryablePattern,
} from "@stella/shared";

/**
 * Allowlist strategy: only specific known patterns are retryable.
 * Abort and context overflow errors are explicitly excluded.
 */
export function isRetryableModelError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isContextOverflowError(error)) return false;
  return matchesRetryablePattern(error);
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
