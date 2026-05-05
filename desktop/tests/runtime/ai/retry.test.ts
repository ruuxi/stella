import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRetryableConnectionError,
  retryWithBackoff,
} from "../../../../runtime/ai/utils/retry.js";

describe("provider retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses OpenCode-style exponential delays for retryable provider failures", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 503 }))
      .mockResolvedValueOnce("ok");

    const result = retryWithBackoff(fn);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honors provider retry-after headers", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("too many requests"), {
          status: 429,
          headers: { "retry-after-ms": "1500" },
        }),
      )
      .mockResolvedValueOnce("ok");

    const result = retryWithBackoff(fn);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry context overflow errors", () => {
    expect(isRetryableConnectionError(new Error("context_length_exceeded"))).toBe(false);
  });
});
