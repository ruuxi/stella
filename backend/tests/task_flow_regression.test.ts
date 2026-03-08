import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

describe("task flow regression", () => {
  test("backend task delegation runtime file is removed", () => {
    expect(existsSync(path.join(backendRoot, "convex/agent/tasks.ts"))).toBe(false);
  });
});
