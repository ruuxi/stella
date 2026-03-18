import { sleep } from "./async";

type RetryFetchOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const parseRetryAfterMs = (headerValue: string | null): number | null => {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const at = Date.parse(headerValue);
  if (!Number.isNaN(at)) {
    return Math.max(0, at - Date.now());
  }

  return null;
};

const isRetriableStatus = (status: number) => status === 429 || status >= 500;

export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 400);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 3_000);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!isRetriableStatus(res.status) || attempt === attempts) {
        return res;
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(retryAfterMs ?? backoffMs);
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }
  }

  throw lastError ?? new Error("retryFetch failed");
}
