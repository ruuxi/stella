import { sleep } from "../lib/async";
import {
  isAbortError,
  isContextOverflowError,
} from "../lib/error_classification";

const RETRY_INITIAL_DELAY_MS = 2_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_DELAY_NO_HEADERS_MS = 30_000;
const RETRY_MAX_DELAY_MS = 2_147_483_647;

type RetryOptions = {
  maxAttempts?: number;
  signal?: AbortSignal;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

const capDelay = (ms: number): number => Math.min(Math.max(0, ms), RETRY_MAX_DELAY_MS);

const readHeader = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
};

export const readRetryAfterMs = (error: unknown): number | undefined => {
  const headers =
    (error as { headers?: unknown })?.headers ??
    (error as { responseHeaders?: unknown })?.responseHeaders ??
    (error as { response?: { headers?: unknown } })?.response?.headers;

  const retryAfterMs = readHeader(headers, "retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return capDelay(parsed);
  }

  const retryAfter = readHeader(headers, "retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return capDelay(Math.ceil(seconds * 1000));
  const dateMs = Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(dateMs) && dateMs > 0) return capDelay(Math.ceil(dateMs));
  return undefined;
};

export const retryDelayMs = (attempt: number, error?: unknown): number =>
  readRetryAfterMs(error) ??
  capDelay(
    Math.min(
      RETRY_INITIAL_DELAY_MS * RETRY_BACKOFF_FACTOR ** Math.max(0, attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS_MS,
    ),
  );

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "errorMessage" in error) {
    return String((error as { errorMessage: unknown }).errorMessage);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

export const isRetryableProviderError = (error: unknown): boolean => {
  if (isAbortError(error) || isContextOverflowError(error)) return false;
  const status = (error as { status?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("resource_exhausted") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up")
  );
};

export async function retryProviderRequest<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const isRetryable = options.isRetryable ?? isRetryableProviderError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error("Request was aborted");
    try {
      return await fn();
    } catch (error) {
      if (isAbortError(error) || attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = retryDelayMs(attempt, error);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("Provider retry failed");
}
