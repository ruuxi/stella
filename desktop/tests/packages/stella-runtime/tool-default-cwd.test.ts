import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiTools } from "../../../packages/runtime-kernel/agent-runtime/tool-adapters.js";
import { resolveLocalCliCwd } from "../../../packages/runtime-kernel/agent-runtime/shared.js";
import { handleEdit, handleRead, handleWrite } from "../../../packages/runtime-kernel/tools/file.js";
import { handleGlob, handleGrep } from "../../../packages/runtime-kernel/tools/search.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import type { ToolContext, ToolResult } from "../../../packages/runtime-kernel/tools/types.js";

const tempRoots: string[] = [];

const createTempDir = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-tool-cwd-"));
  tempRoots.push(root);
  return root;
};

const toolContext = (frontendRoot: string): ToolContext => ({
  conversationId: "conv-1",
  deviceId: "device-1",
  requestId: "req-1",
  frontendRoot,
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("default runtime cwd", () => {
  it("resolves desktop as the default local CLI cwd for general, self_mod, and dashboard_generation", () => {
    const frontendRoot = "C:/repo/desktop";

    expect(
      resolveLocalCliCwd({
        agentType: AGENT_IDS.GENERAL,
        frontendRoot,
      }),
    ).toBe(frontendRoot);

    expect(
      resolveLocalCliCwd({
        agentType: AGENT_IDS.SELF_MOD,
        frontendRoot,
      }),
    ).toBe(frontendRoot);

    expect(
      resolveLocalCliCwd({
        agentType: AGENT_IDS.DASHBOARD_GENERATION,
        frontendRoot,
      }),
    ).toBe(frontendRoot);
  });

  it("passes frontendRoot into PI tool context for delegated tool calls", async () => {
    const toolExecutor = vi.fn(
      async (
        _toolName: string,
        _args: Record<string, unknown>,
        _context: ToolContext,
        _signal?: AbortSignal,
      ): Promise<ToolResult> => ({ result: "ok" }),
    );

    const tools = createPiTools({
      runId: "run-1",
      conversationId: "conv-1",
      agentType: AGENT_IDS.GENERAL,
      deviceId: "device-1",
      stellaHome: "C:/stella-home",
      frontendRoot: "C:/repo/desktop",
      store: {
        saveMemory: vi.fn(),
        recallMemories: vi.fn().mockReturnValue([]),
      } as never,
      toolExecutor,
    });

    const bashTool = tools.find((tool) => tool.name === "Bash");
    expect(bashTool).toBeTruthy();

    await bashTool!.execute("tool-1", { command: "pwd" }, undefined);

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0]?.[2]).toMatchObject({
      agentType: AGENT_IDS.GENERAL,
      frontendRoot: "C:/repo/desktop",
    });
  });

  it("uses frontendRoot as the default base path for search tools", async () => {
    const frontendRoot = createTempDir();
    const filePath = path.join(frontendRoot, "sample.tsx");
    fs.writeFileSync(filePath, 'export const sample = "hello";\n', "utf-8");

    const globResult = await handleGlob({ pattern: "*.tsx" }, toolContext(frontendRoot));
    expect(String(globResult.result ?? "")).toContain(filePath);

    const grepResult = await handleGrep(
      { pattern: "sample", output_mode: "content" },
      toolContext(frontendRoot),
    );
    expect(String(grepResult.result ?? "")).toContain(filePath);
    expect(String(grepResult.result ?? "")).toContain("sample");
  });

  it("uses frontendRoot as the default base path for file tools", async () => {
    const frontendRoot = createTempDir();
    const appDir = path.join(frontendRoot, "src", "app");
    const filePath = path.join(appDir, "registry.ts");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(filePath, "export const pages = [];\n", "utf-8");

    const readResult = await handleRead(
      { file_path: "src/app/registry.ts" },
      toolContext(frontendRoot),
    );
    expect(String(readResult.result ?? "")).toContain(filePath);

    const editResult = await handleEdit(
      {
        file_path: "src/app/registry.ts",
        old_string: "export const pages = [];",
        new_string: 'export const pages = ["demo"];',
      },
      toolContext(frontendRoot),
    );
    expect(String(editResult.result ?? "")).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf-8")).toContain('"demo"');

    const writeResult = await handleWrite(
      {
        file_path: "src/app/new-panel/index.tsx",
        content: "export default function Demo() { return null; }\n",
      },
      toolContext(frontendRoot),
    );

    const newFilePath = path.join(frontendRoot, "src", "app", "new-panel", "index.tsx");
    expect(String(writeResult.result ?? "")).toContain(newFilePath);
    expect(fs.readFileSync(newFilePath, "utf-8")).toContain("Demo");
  });
});
