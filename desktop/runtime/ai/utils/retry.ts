/**
 * Generic retry with exponential backoff.
 *
 * Default schedule (10 attempts):
 *   attempts 1–3 retry at a flat 1 s delay,
 *   then 2 s → 4 s → 8 s → 16 s → 32 s → 64 s (capped).
 */

export interface RetryOptions {
	/** Total attempts including the first try. Default: 10. */
	maxAttempts?: number;
	/** Delay used for the initial flat-retry window. Default: 1000 ms. */
	baseDelayMs?: number;
	/** Ceiling for any single delay. Default: 64000 ms. */
	maxDelayMs?: number;
	/** How many of the first retries stay at `baseDelayMs` before ramping. Default: 3. */
	flatRetries?: number;
	signal?: AbortSignal;
	/** Return `true` for errors that should be retried. Falls back to `isRetryableConnectionError`. */
	isRetryable?: (error: unknown) => boolean;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? 10;
	const baseDelayMs = options?.baseDelayMs ?? 1000;
	const maxDelayMs = options?.maxDelayMs ?? 64_000;
	const flatRetries = options?.flatRetries ?? 3;
	const signal = options?.signal;
	const isRetryable = options?.isRetryable ?? isRetryableConnectionError;

	let lastError: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (signal?.aborted) {
			throw new Error("Request was aborted");
		}

		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (isAbortError(error)) throw error;

			const isLast = attempt >= maxAttempts - 1;
			if (isLast || !isRetryable(error)) throw error;

			const delayMs = retryDelay(attempt, baseDelayMs, maxDelayMs, flatRetries);
			await retrySleep(delayMs, signal);
		}
	}

	throw lastError;
}

function retryDelay(retryIndex: number, baseDelayMs: number, maxDelayMs: number, flatRetries: number): number {
	if (retryIndex < flatRetries) return baseDelayMs;
	return Math.min(baseDelayMs * 2 ** (retryIndex - flatRetries + 1), maxDelayMs);
}

function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.message === "Request was aborted";
}

/**
 * Heuristic for connection / transient server errors that are safe to retry.
 * Works with OpenAI SDK error shapes (`error.status`, `error.code`) and
 * generic network errors.
 */
export function isRetryableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const status = (error as { status?: number }).status;
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}

	const code = (error as { code?: string }).code;
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
		return true;
	}

	return /connection.?(refused|reset|timed?\s*out|error)|network|fetch\s*failed|socket\s*hang\s*up/i.test(
		error.message,
	);
}
