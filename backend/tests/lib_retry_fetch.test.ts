import { describe, test, expect } from "bun:test";
import { retryFetch } from "../convex/lib/retry_fetch";

describe("retryFetch", () => {
  test("returns response on success", async () => {
    const mockUrl = "https://httpbin.org/status/200";
    // Use a mock by creating a custom function scope
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      const res = await retryFetch("http://example.com/test", {}, { attempts: 1 });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns last response on non-retriable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    try {
      const res = await retryFetch("http://example.com/test", {}, { attempts: 3 });
      expect(res.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 429 status", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 2) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("ok", { status: 200 });
    };
    try {
      const res = await retryFetch("http://example.com/test", {}, {
        attempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
      });
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 500 status", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    };
    try {
      const res = await retryFetch("http://example.com/test", {}, {
        attempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
      });
      expect(res.status).toBe(200);
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on network error after all attempts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network error"); };
    try {
      await expect(
        retryFetch("http://example.com/test", {}, {
          attempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 5,
        }),
      ).rejects.toThrow("network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults to 3 attempts", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response("error", { status: 500 });
    };
    try {
      await retryFetch("http://example.com/test", {}, {
        baseDelayMs: 1,
        maxDelayMs: 5,
      });
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
