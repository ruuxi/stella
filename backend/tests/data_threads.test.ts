import { describe, test, expect } from "bun:test";
import {
  deriveThreadLifecycleStatus,
  THREAD_IDLE_AFTER_MS,
  THREAD_ARCHIVE_AFTER_MS,
} from "../convex/data/threads";

describe("THREAD_IDLE_AFTER_MS", () => {
  test("is 7 days in milliseconds", () => {
    expect(THREAD_IDLE_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("THREAD_ARCHIVE_AFTER_MS", () => {
  test("is 30 days in milliseconds", () => {
    expect(THREAD_ARCHIVE_AFTER_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("is greater than idle threshold", () => {
    expect(THREAD_ARCHIVE_AFTER_MS).toBeGreaterThan(THREAD_IDLE_AFTER_MS);
  });
});

describe("deriveThreadLifecycleStatus", () => {
  const now = Date.now();

  test("returns active for recently used thread", () => {
    const result = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - 1000,
      now,
    });
    expect(result).toBe("active");
  });

  test("returns idle when past idle threshold", () => {
    const result = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - THREAD_IDLE_AFTER_MS - 1,
      now,
    });
    expect(result).toBe("idle");
  });

  test("returns archived when past archive threshold", () => {
    const result = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - THREAD_ARCHIVE_AFTER_MS - 1,
      now,
    });
    expect(result).toBe("archived");
  });

  test("keeps archived status regardless of time", () => {
    const result = deriveThreadLifecycleStatus({
      status: "archived",
      lastUsedAt: now - 1000,
      now,
    });
    expect(result).toBe("archived");
  });

  test("uses custom idleAfterMs", () => {
    const result = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - 5000,
      now,
      idleAfterMs: 3000,
    });
    expect(result).toBe("idle");
  });

  test("uses custom archiveAfterMs", () => {
    const result = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - 10000,
      now,
      archiveAfterMs: 5000,
    });
    expect(result).toBe("archived");
  });

  test("normalizes unknown status to active", () => {
    const result = deriveThreadLifecycleStatus({
      status: "unknown",
      lastUsedAt: now - 1000,
      now,
    });
    expect(result).toBe("active");
  });
});
