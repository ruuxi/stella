import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("task flow regression", () => {
  test("top-level task flow still schedules execute and delivery stages", () => {
    const source = readBackendFile("convex/agent/tasks.ts");

    expect(source).toContain("export const executeSubagent = internalAction");
    expect(source).toContain("executeSubagentRun(ctx");
    expect(source).toContain("internal.agent.tasks.deliverTaskResult");
    expect(source).toContain("internal.agent.tasks.taskCheckin");
    expect(source).toContain("runAfter(0, internal.agent.tasks.executeSubagent");
  });
});
