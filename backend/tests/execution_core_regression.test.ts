import fs from "fs";
import path from "path";
import { describe, expect, test } from "bun:test";

const backendRoot = path.resolve(__dirname, "..");
const readBackendFile = (relativePath: string): string =>
  fs.readFileSync(path.join(backendRoot, relativePath), "utf8");

describe("execution core regressions", () => {
  test("shared model execution helper is used by major backend execution paths", () => {
    const automationRunner = readBackendFile("convex/automation/runner.ts");
    const httpSource = readBackendFile("convex/http.ts");
    const invokeSource = readBackendFile("convex/agent/invoke.ts");

    expect(automationRunner).toContain('from "../agent/model_execution"');
    // http.ts no longer imports model_execution directly — it delegates through ai_proxy
    expect(httpSource).toContain('from "./ai_proxy"');
    // invoke.ts now directly uses model_execution (execution.ts wrapper was removed)
    expect(invokeSource).toContain('from "./model_execution"');
    expect(invokeSource).toContain('from "./model_resolver"');
    expect(fs.existsSync(path.join(backendRoot, "convex/agent/tasks.ts"))).toBe(false);
  });

  test("model execution core stays free of Convex action/electron runtime imports", () => {
    const source = readBackendFile("convex/agent/model_execution.ts");

    expect(source).not.toContain("_generated/server");
    expect(source).not.toContain("ActionCtx");
    expect(source).not.toContain("electron");
    expect(source).toContain("streamTextWithFailover");
    expect(source).toContain("generateTextWithFailover");
  });
});
