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

const createContext = (
  stellaRoot: string,
  overrides?: Partial<ToolContext>,
): ToolContext => ({
  conversationId: "conversation-test",
  deviceId: "device-test",
  requestId: "request-test",
  runId: "run-test",
  agentType: "general",
  stellaRoot,
  storageMode: "local",
  ...overrides,
});

const createHost = (
  stellaRoot: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaUiCliPath?: string;
  },
) =>
  createToolHost({
    stellaRoot,
    ...options,
  });

describe("ExecuteTypescript tool", () => {
  it("runs TypeScript, returns structured data, and streams updates", async () => {
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const host = createHost(stellaRoot);
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
      createContext(stellaRoot),
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
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const lifeRoot = path.join(stellaRoot, "life");

    mkdirSync(path.join(lifeRoot, "knowledge"), { recursive: true });
    mkdirSync(path.join(lifeRoot, "capabilities", "to-upper"), {
      recursive: true,
    });

    writeFileSync(path.join(stellaRoot, "demo.txt"), "hello stella", "utf-8");
    writeFileSync(
      path.join(lifeRoot, "knowledge", "guide.md"),
      "# Guide\n\nVerified workflow.",
      "utf-8",
    );
    writeFileSync(
      path.join(lifeRoot, "capabilities", "to-upper", "index.md"),
      "---\nname: to-upper\ndescription: Uppercase text.\n---\n",
      "utf-8",
    );
    writeFileSync(
      path.join(lifeRoot, "capabilities", "to-upper", "program.ts"),
      'return String(input ?? "").toUpperCase();',
      "utf-8",
    );

    const host = createHost(stellaRoot);
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
      createContext(stellaRoot),
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

  it("runs shell.exec with string-first arguments and rejects the old object form", async () => {
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const host = createHost(stellaRoot);

    const success = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "run shell commands",
        code: `
const pwd = await shell.exec("pwd", { workingDirectory: "." });
const printed = await shell.exec("printf 'hello'");
return { pwd: pwd.trim(), printed };
        `,
      },
      createContext(stellaRoot),
    );

    expect(success.error).toBeUndefined();
    expect(success.result).toEqual({
      pwd: expect.stringContaining(stellaRoot),
      printed: "hello",
    });

    const failure = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "old shell.exec form",
        code: `
return await shell.exec({ command: "pwd" });
        `,
      },
      createContext(stellaRoot),
    );

    expect(failure.error).toContain(
      "shell.exec now expects shell.exec(command, options?)",
    );
  });

  it("exposes Stella CLI wrappers inside ExecuteTypescript shell.exec", async () => {
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const fakeBrowserPath = path.join(stellaRoot, "fake-stella-browser.js");
    writeFileSync(
      fakeBrowserPath,
      `console.log(JSON.stringify({
  args: process.argv.slice(2),
  provider: process.env.STELLA_BROWSER_PROVIDER ?? null,
  session: process.env.STELLA_BROWSER_SESSION ?? null,
  owner: process.env.STELLA_BROWSER_OWNER_ID ?? null,
}));`,
      "utf-8",
    );

    const host = createHost(stellaRoot, {
      stellaBrowserBinPath: fakeBrowserPath,
    });
    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "run stella browser wrapper",
        code: `
return await shell.exec("stella-browser snapshot -i");
        `,
      },
      createContext(stellaRoot, { taskId: "task-test" }),
    );

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.result))).toEqual({
      args: ["snapshot", "-i"],
      provider: "extension",
      session: "stella-app-bridge",
      owner: "task-test",
    });
  });

  it("allows full Node globals like Buffer", async () => {
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const host = createHost(stellaRoot);

    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "use buffer",
        code: `
return {
  base64: Buffer.from("stella").toString("base64"),
  cwd: process.cwd(),
};
        `,
      },
      createContext(stellaRoot),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      base64: "c3RlbGxh",
      cwd: expect.stringContaining(stellaRoot),
    });
  });

  it("rejects static import syntax in program bodies", async () => {
    const stellaRoot = createTempDir("stella-code-mode-root-");
    const host = createHost(stellaRoot);

    const result = await host.executeTool(
      "ExecuteTypescript",
      {
        summary: "try static import",
        code: `
import fs from "node:fs";
return fs.readdirSync(".");
        `,
      },
      createContext(stellaRoot),
    );

    expect(result.error).toContain("Static import/export are not supported");
  });
});
