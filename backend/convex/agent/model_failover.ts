/**
 * Model failover — wraps AI SDK calls with automatic fallback to a secondary model
 * when the primary model fails (API errors, rate limits, auth failures, etc.).
 *
 * Usage:
 *   const fallbackConfig = await resolveFallbackConfig(ctx, agentType, ownerId);
 *   const result = await withModelFailover(
 *     () => streamText({ ...primaryConfig, ... }),
 *     fallbackConfig ? () => streamText({ ...fallbackConfig, ... }) : undefined,
 *   );
 */

/**
 * Check if an error is an abort/cancellation error that should NOT trigger failover.
 * These represent intentional cancellations (user navigated away, task canceled, etc.).
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) return true;
    if (error.name === "AbortError") return true;
  }
  return false;
}

/**
 * Check if an error is a model/API error that should trigger failover.
 * We fail over on: network errors, auth errors, rate limits, server errors,
 * model not found, etc. We do NOT fail over on abort errors or context overflow
 * (which are better handled by the caller's own retry logic).
 */
function shouldFailover(error: unknown): boolean {
  if (isAbortError(error)) return false;

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Context overflow should be handled by caller (e.g. halving history budget)
    if (msg.includes("context") && (msg.includes("overflow") || msg.includes("too long") || msg.includes("too large"))) {
      return false;
    }
    // Convex-specific errors that aren't model failures
    if (msg.includes("convex") && msg.includes("function")) return false;
  }

  // Everything else (rate limit, auth, network, 500, model not found, etc.) → failover
  return true;
}

/**
 * Execute a primary function, falling back to a secondary function if the primary fails
 * with a model/API error.
 *
 * @param primaryFn - The primary operation using the default model
 * @param fallbackFn - Optional fallback operation using the fallback model (if undefined, error propagates)
 * @param options.onFallback - Optional callback invoked when failover occurs (for logging)
 */
export function withModelFailover<T>(
  primaryFn: () => T,
  fallbackFn?: () => T,
  options?: { onFallback?: (error: unknown) => void },
): T {
  try {
    return primaryFn();
  } catch (error) {
    // No fallback configured — propagate the error
    if (!fallbackFn) throw error;

    // Only fail over on model/API errors
    if (!shouldFailover(error)) throw error;

    console.warn(
      `[model-failover] Primary model failed, attempting fallback. Error: ${
        (error as Error)?.message ?? String(error)
      }`,
    );

    options?.onFallback?.(error);

    return fallbackFn();
  }
}

/**
 * Async version of withModelFailover for use with generateText and other async calls.
 */
export async function withModelFailoverAsync<T>(
  primaryFn: () => Promise<T>,
  fallbackFn?: () => Promise<T>,
  options?: { onFallback?: (error: unknown) => void },
): Promise<T> {
  try {
    return await primaryFn();
  } catch (error) {
    // No fallback configured — propagate the error
    if (!fallbackFn) throw error;

    // Only fail over on model/API errors
    if (!shouldFailover(error)) throw error;

    console.warn(
      `[model-failover] Primary model failed, attempting fallback. Error: ${
        (error as Error)?.message ?? String(error)
      }`,
    );

    options?.onFallback?.(error);

    return await fallbackFn();
  }
}
