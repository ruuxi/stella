import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";
import { createToolHost } from "../../../../../runtime/kernel/tools/host.js";
import {
  createShellState,
  handleExecCommand,
  handleWriteStdin,
} from "../../../../../runtime/kernel/tools/shell.js";
import { handleViewImage } from "../../../../../runtime/kernel/tools/view-image.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-codex-tools-"));
  tempDirs.push(dir);
  return dir;
};

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

describe("codex-style general tools", () => {
  it("exec_command returns one-shot output inline", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf ready",
        yield_time_ms: 500,
      },
      { conversationId: "c1", deviceId: "d1", requestId: "r1", stellaRoot: root },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
      output: "ready",
    });
  });

  it("write_stdin continues an interactive exec_command session", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const context = {
      conversationId: "c1",
      deviceId: "d1",
      requestId: "r1",
      stellaRoot: root,
    };

    const started = await handleExecCommand(
      shellState,
      {
        cmd: 'read line; printf "echo:%s" "$line"',
        yield_time_ms: 100,
      },
      context,
    );

    expect(started.error).toBeUndefined();
    const sessionId = (started.result as { session_id: string | null }).session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "hello world\n",
        yield_time_ms: 500,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect((finished.result as { output: string }).output).toContain("echo:hello world");
  });

  it("apply_patch updates an existing file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch({
      patch: `*** Begin Patch
*** Update File: ${filePath}
@@
 hello
-world
+stella
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("hello\nstella\n");
  });

  it("view_image returns an attach marker for local images", async () => {
    const root = await createTempDir();
    const imagePath = path.join(root, "snap.png");
    await writeFile(imagePath, ONE_BY_ONE_PNG);

    const result = await handleViewImage(
      { path: imagePath },
      { conversationId: "c1", deviceId: "d1", requestId: "r1", stellaRoot: root },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(`[stella-attach-image] inline=image/png ${imagePath}`);
  });

  it("multi_tool_use.parallel runs independent tool calls", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaRoot: root });

    try {
      const result = await host.executeTool(
        "multi_tool_use.parallel",
        {
          tool_uses: [
            {
              recipient_name: "exec_command",
              parameters: { cmd: "printf one", yield_time_ms: 500 },
            },
            {
              recipient_name: "functions.exec_command",
              parameters: { cmd: "printf two", yield_time_ms: 500 },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaRoot: root,
          allowedToolNames: ["exec_command", "multi_tool_use.parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(typeof result.result).toBe("string");
      expect(result.result as string).toContain("one");
      expect(result.result as string).toContain("two");
    } finally {
      await host.shutdown();
    }
  });

  it("web uses the configured search backend", async () => {
    const root = await createTempDir();
    const host = createToolHost({
      stellaRoot: root,
      webSearch: async (query) => ({
        text: `results for ${query}`,
        results: [{ title: "Stella", url: "https://stella.sh", snippet: "assistant" }],
      }),
    });

    try {
      const result = await host.executeTool(
        "web",
        { query: "stella assistant" },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaRoot: root,
          allowedToolNames: ["web"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe("results for stella assistant");
      expect(result.details).toMatchObject({
        mode: "search",
        query: "stella assistant",
      });
    } finally {
      await host.shutdown();
    }
  });

  it("RequestCredential delegates to the device callback", async () => {
    const root = await createTempDir();
    const host = createToolHost({
      stellaRoot: root,
      requestCredential: async (payload) => ({
        secretId: `secret:${payload.provider}`,
        provider: payload.provider,
        label: payload.label ?? payload.provider,
      }),
    });

    try {
      const result = await host.executeTool(
        "RequestCredential",
        {
          provider: "github_token",
          label: "GitHub Token",
          description: "Needed for API access",
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaRoot: root,
          allowedToolNames: ["RequestCredential"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        secretId: "secret:github_token",
        provider: "github_token",
        label: "GitHub Token",
      });
    } finally {
      await host.shutdown();
    }
  });
});
