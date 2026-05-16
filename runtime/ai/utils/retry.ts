export interface RetryOptions {
	/** Total attempts including the first try. Default: 10. */
	maxAttempts?: number;
	/** Fixed delay for the first retry window. Default: 1000 ms. */
	baseDelayMs?: number;
	/** Ceiling for non-header retry delays. Default: 16000 ms. */
	maxDelayMs?: number;
	/**
	 * Total time budget for all retry sleeps combined. Once the accumulated
	 * sleep time would exceed this, the next failure surfaces immediately
	 * instead of waiting further. Default: 60000 ms.
	 */
	maxTotalDelayMs?: number;
	signal?: AbortSignal;
	/** Return `true` for errors that should be retried. Falls back to `isRetryableConnectionError`. */
	isRetryable?: (error: unknown) => boolean;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? 10;
	const baseDelayMs = options?.baseDelayMs ?? 1_000;
	const maxDelayMs = options?.maxDelayMs ?? 16_000;
	const maxTotalDelayMs = options?.maxTotalDelayMs ?? 60_000;
	const signal = options?.signal;
	const isRetryable = options?.isRetryable ?? isRetryableConnectionError;

	let lastError: unknown;
	let elapsedDelayMs = 0;

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

			const requestedDelayMs =
				readRetryAfterMs(error) ?? retryDelay(attempt, baseDelayMs, maxDelayMs);
			const remainingBudgetMs = Math.max(0, maxTotalDelayMs - elapsedDelayMs);
			if (remainingBudgetMs <= 0) throw error;
			const delayMs = Math.min(requestedDelayMs, remainingBudgetMs);
			elapsedDelayMs += delayMs;
			await retrySleep(delayMs, signal);
		}
	}

	throw lastError;
}

function retryDelay(retryIndex: number, baseDelayMs: number, maxDelayMs: number): number {
	if (retryIndex < 3) return baseDelayMs;
	return Math.min(baseDelayMs * 2 ** (retryIndex - 2), maxDelayMs);
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

function readHeader(headers: unknown, name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (typeof (headers as { get?: unknown }).get === "function") {
		const value = (headers as { get: (key: string) => unknown }).get(name);
		return typeof value === "string" ? value : undefined;
	}
	const record = headers as Record<string, unknown>;
	const value = record[name] ?? record[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
	const headers =
		(error as { headers?: unknown })?.headers ??
		(error as { responseHeaders?: unknown })?.responseHeaders ??
		(error as { response?: { headers?: unknown } })?.response?.headers;
	const retryAfterMs = readHeader(headers, "retry-after-ms");
	if (retryAfterMs) {
		const parsed = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 2_147_483_647);
	}
	const retryAfter = readHeader(headers, "retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 2_147_483_647);
	const dateMs = Date.parse(retryAfter) - Date.now();
	if (Number.isFinite(dateMs) && dateMs > 0) return Math.min(Math.ceil(dateMs), 2_147_483_647);
	return undefined;
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
	const statusCode = (error as { statusCode?: number }).statusCode;
	if (statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500)) return true;

	const code = (error as { code?: string }).code;
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
		return true;
	}

	return /connection.?(refused|reset|timed?\s*out|error)|network|fetch\s*failed|socket\s*hang\s*up/i.test(
		error.message,
	) || /rate limit|too many requests|resource.?exhausted|temporarily unavailable|overloaded/i.test(error.message);
}
