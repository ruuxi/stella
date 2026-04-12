import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolHost } from "../../../../runtime/kernel/tools/host.js";
import type { ToolContext, ToolResult } from "../../../../runtime/kernel/tools/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const createTempDir = (prefix: string) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
};

const createContext = (frontendRoot: string): ToolContext => ({
  conversationId: "conversation-test",
  deviceId: "device-test",
  requestId: "request-test",
  runId: "run-test",
  agentType: "general",
  frontendRoot,
  storageMode: "local",
});

const createHost = (frontendRoot: string, stellaHomePath: string) =>
  createToolHost({
    frontendRoot,
    stellaHomePath,
  });

describe("ExecuteTypescript tool", () => {
  it("runs TypeScript, returns structured data, and streams updates", async () => {
    const frontendRoot = createTempDir("stella-code-mode-workspace-");
    const stellaHomePath = createTempDir("stella-code-mode-home-");
    const host = createHost(frontendRoot, stellaHomePath);
    const updates: ToolResult[] = [];

    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "sum values",
        code: `
const values = [1, 2, 3];
console.log("count", values.length);
return {
  total: values.reduce((sum, value) => sum + value, 0),
  average: values.reduce((sum, value) => sum + value, 0) / values.length,
};
        `,
      },
      createContext(frontendRoot),
      undefined,
      (update) => updates.push(update),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ total: 6, average: 2 });

    const details = result.details as {
      success: boolean;
      logs: Array<{ level: string; message: string }>;
    };
    expect(details.success).toBe(true);
    expect(details.logs[0]?.message).toContain("count 3");
    expect(
      updates.some(
        (update) =>
          (update.details as { kind?: string } | undefined)?.kind === "console",
      ),
    ).toBe(true);
  });

  it("reads life docs, writes workspace files, and runs reusable libraries", async () => {
    const frontendRoot = createTempDir("stella-code-mode-workspace-");
    const stellaHomePath = createTempDir("stella-code-mode-home-");
    const lifeRoot = path.join(stellaHomePath, "life");

    mkdirSync(path.join(lifeRoot, "knowledge"), { recursive: true });
    mkdirSync(path.join(lifeRoot, "libraries", "to-upper"), {
      recursive: true,
    });

    writeFileSync(path.join(frontendRoot, "demo.txt"), "hello stella", "utf-8");
    writeFileSync(
      path.join(lifeRoot, "knowledge", "guide.md"),
      "# Guide\n\nVerified workflow.",
      "utf-8",
    );
    writeFileSync(
      path.join(lifeRoot, "libraries", "to-upper", "index.md"),
      "---\nname: to-upper\ndescription: Uppercase text.\n---\n",
      "utf-8",
    );
    writeFileSync(
      path.join(lifeRoot, "libraries", "to-upper", "program.ts"),
      'return String(input ?? "").toUpperCase();',
      "utf-8",
    );

    const host = createHost(frontendRoot, stellaHomePath);
    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "read life and run library",
        code: `
const original = await workspace.readText("demo.txt");
await workspace.writeText("result.txt", original.toUpperCase());
const guide = await life.read("guide");
const transformed = await libraries.run("to-upper", original);
const written = await workspace.readText("result.txt");
return { original, guide, transformed, written };
        `,
      },
      createContext(frontendRoot),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      original: "hello stella",
      guide: "# Guide\n\nVerified workflow.",
      transformed: "HELLO STELLA",
      written: "HELLO STELLA",
    });

    const details = result.details as {
      calls: Array<{ binding: string; method: string }>;
      libraries: Array<{ name: string }>;
    };
    expect(
      details.calls.some(
        (entry) => entry.binding === "workspace" && entry.method === "writeText",
      ),
    ).toBe(true);
    expect(details.libraries[0]?.name).toBe("to-upper");
  });

  it("rejects unsupported imports", async () => {
    const frontendRoot = createTempDir("stella-code-mode-workspace-");
    const stellaHomePath = createTempDir("stella-code-mode-home-");
    const host = createHost(frontendRoot, stellaHomePath);

    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "try imports",
        code: `
import fs from "node:fs";
return fs.readdirSync(".");
        `,
      },
      createContext(frontendRoot),
    );

    expect(result.error).toContain("Use Stella bindings");
  });
});
