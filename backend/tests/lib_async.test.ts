import { describe, test, expect } from "bun:test";
import { sleep } from "../convex/lib/async";

describe("sleep", () => {
  test("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });

  test("resolves with undefined", async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });

  test("returns a Promise", () => {
    const result = sleep(1);
    expect(result).toBeInstanceOf(Promise);
  });
});
