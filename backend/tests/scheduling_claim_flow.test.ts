import { describe, test, expect } from "bun:test";
import { DEFAULT_STUCK_RUN_MS } from "../convex/scheduling/claim_flow";
import type { ClaimFlowBuildContext } from "../convex/scheduling/claim_flow";

describe("DEFAULT_STUCK_RUN_MS", () => {
  test("is a positive number", () => {
    expect(typeof DEFAULT_STUCK_RUN_MS).toBe("number");
    expect(DEFAULT_STUCK_RUN_MS).toBeGreaterThan(0);
  });

  test("is 2 hours in milliseconds", () => {
    expect(DEFAULT_STUCK_RUN_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("ClaimFlowBuildContext type", () => {
  test("type is structurally valid", () => {
    const context: ClaimFlowBuildContext = {
      nowMs: Date.now(),
      expectedRunningAtMs: undefined,
    };
    expect(context.nowMs).toBeGreaterThan(0);
    expect(context.expectedRunningAtMs).toBeUndefined();
  });

  test("supports numeric expectedRunningAtMs", () => {
    const context: ClaimFlowBuildContext = {
      nowMs: Date.now(),
      expectedRunningAtMs: Date.now() - 1000,
    };
    expect(typeof context.expectedRunningAtMs).toBe("number");
  });
});
