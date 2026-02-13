import { describe, expect, test } from "bun:test";
import {
  MEMORY_ARCHITECTURE_CONSTANTS,
  parseDiffDecision,
} from "../convex/data/memory_architecture";
import {
  THREAD_ARCHIVE_AFTER_MS,
  THREAD_IDLE_AFTER_MS,
  deriveThreadLifecycleStatus,
} from "../convex/data/threads";

describe("memory architecture helpers", () => {
  test("parses valid diff decision", () => {
    const parsed = parseDiffDecision(
      JSON.stringify({
        updates: [{ index: 1, content: "updated" }],
        deletes: [{ index: 2 }],
      }),
    );

    expect(parsed.updates).toEqual([{ index: 1, content: "updated" }]);
    expect(parsed.deletes).toEqual([{ index: 2 }]);
  });

  test("extracts json object from noisy model output", () => {
    const parsed = parseDiffDecision(
      "Result:\n{\"updates\":[{\"index\":0,\"content\":\"new\"}],\"deletes\":[]}",
    );

    expect(parsed.updates).toEqual([{ index: 0, content: "new" }]);
    expect(parsed.deletes).toEqual([]);
  });

  test("uses expected architecture limits", () => {
    expect(MEMORY_ARCHITECTURE_CONSTANTS.TOKEN_FALLBACK_THRESHOLD).toBe(20_000);
    expect(MEMORY_ARCHITECTURE_CONSTANTS.MAX_MEMORIES_PER_OWNER).toBe(500);
    expect(MEMORY_ARCHITECTURE_CONSTANTS.MAX_MEMORIES_PER_SUBCATEGORY).toBe(30);
  });
});

describe("thread lifecycle derivation", () => {
  const now = Date.now();

  test("stays active before idle threshold", () => {
    const status = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - THREAD_IDLE_AFTER_MS + 1,
      now,
    });

    expect(status).toBe("active");
  });

  test("moves to idle after idle threshold", () => {
    const status = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - THREAD_IDLE_AFTER_MS,
      now,
    });

    expect(status).toBe("idle");
  });

  test("moves to archived after archive threshold", () => {
    const status = deriveThreadLifecycleStatus({
      status: "active",
      lastUsedAt: now - THREAD_ARCHIVE_AFTER_MS,
      now,
    });

    expect(status).toBe("archived");
  });

  test("keeps archived as archived", () => {
    const status = deriveThreadLifecycleStatus({
      status: "archived",
      lastUsedAt: now,
      now,
    });

    expect(status).toBe("archived");
  });
});
