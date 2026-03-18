import { describe, test, expect } from "bun:test";
import {
  withModelFailover,
  withModelFailoverAsync,
} from "../convex/agent/model_failover";

describe("withModelFailover", () => {
  test("returns primary result on success", () => {
    const result = withModelFailover(() => "primary");
    expect(result).toBe("primary");
  });

  test("falls back on primary failure", () => {
    const result = withModelFailover(
      () => { throw new Error("API rate limit"); },
      () => "fallback",
    );
    expect(result).toBe("fallback");
  });

  test("propagates error when no fallback", () => {
    expect(() =>
      withModelFailover(() => { throw new Error("fail"); }),
    ).toThrow("fail");
  });

  test("calls onFallback callback on failover", () => {
    let capturedError: unknown = null;
    withModelFailover(
      () => { throw new Error("oops"); },
      () => "ok",
      { onFallback: (err) => { capturedError = err; } },
    );
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe("oops");
  });

  test("propagates fallback failure", () => {
    expect(() =>
      withModelFailover(
        () => { throw new Error("primary fail"); },
        () => { throw new Error("fallback fail"); },
      ),
    ).toThrow("fallback fail");
  });
});

describe("withModelFailoverAsync", () => {
  test("returns primary result on success", async () => {
    const result = await withModelFailoverAsync(async () => "primary");
    expect(result).toBe("primary");
  });

  test("falls back on primary failure", async () => {
    const result = await withModelFailoverAsync(
      async () => { throw new Error("API error"); },
      async () => "fallback",
    );
    expect(result).toBe("fallback");
  });

  test("propagates error when no fallback", async () => {
    await expect(
      withModelFailoverAsync(async () => { throw new Error("fail"); }),
    ).rejects.toThrow("fail");
  });

  test("calls onFallback callback on failover", async () => {
    let called = false;
    await withModelFailoverAsync(
      async () => { throw new Error("oops"); },
      async () => "ok",
      { onFallback: () => { called = true; } },
    );
    expect(called).toBe(true);
  });
});
