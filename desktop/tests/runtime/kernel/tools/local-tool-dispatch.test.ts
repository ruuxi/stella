import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { dispatchLocalTool } from "../../../../../runtime/kernel/tools/local-tool-dispatch.js";

const activeRoots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "stella-local-tool-dispatch-"),
  );
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    await rm(rootPath, { recursive: true, force: true });
  }
  activeRoots.clear();
});

describe("dispatchLocalTool", () => {
  it("redacts Dream reads before returning memory files to the model", async () => {
    const rootPath = await createRoot();
    const extensionDir = path.join(rootPath, "memories_extensions", "manual");
    await mkdir(extensionDir, { recursive: true });
    const notePath = path.join(extensionDir, "note.md");
    await writeFile(
      notePath,
      "OPENAI_API_KEY=sk-testsecret12345678901234567890\n",
      "utf-8",
    );

    const result = await dispatchLocalTool(
      TOOL_IDS.READ,
      { file_path: notePath },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const text = result.handled ? result.text : "";
    expect(text).not.toContain("sk-testsecret12345678901234567890");
    expect(text).toContain("OPENAI_API_KEY=");
    expect(text).toContain("***");
  });

  it("redacts Dream StrReplace writes before updating durable memory", async () => {
    const rootPath = await createRoot();
    const memoriesDir = path.join(rootPath, "memories");
    await mkdir(memoriesDir, { recursive: true });
    const memoryPath = path.join(memoriesDir, "MEMORY.md");
    await writeFile(memoryPath, "## Active\nold\n", "utf-8");

    const result = await dispatchLocalTool(
      TOOL_IDS.STR_REPLACE,
      {
        file_path: memoryPath,
        old_string: "old",
        new_string: "OPENAI_API_KEY=sk-testsecret12345678901234567890",
      },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const updated = await readFile(memoryPath, "utf-8");
    expect(updated).not.toContain("sk-testsecret12345678901234567890");
    expect(updated).toContain("OPENAI_API_KEY=");
    expect(updated).toContain("***");
  });
});
