import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

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

  it("apply_patch accepts the codex `input` key with a relative path", async () => {
    const root = await createTempDir();
    const relPath = path.join("nested", "notes.txt");
    const absPath = path.join(root, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch(
      {
        input: `*** Begin Patch
*** Update File: ${relPath}
@@
 hello
-world
+stella
*** End Patch`,
      },
      { conversationId: "c1", deviceId: "d1", requestId: "r1", stellaRoot: root },
    );

    expect(result.error).toBeUndefined();
    expect(await readFile(absPath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch resolves relative paths against an explicit workdir", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: notes.txt
@@
 hello
-world
+stella
*** End Patch`,
      workdir: root,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch tolerates trailing whitespace and unicode dashes", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "fuzz.py");
    // Source has a trailing tab and a Unicode en-dash (U+2013) in the line we replace.
    await writeFile(
      filePath,
      "import asyncio\nimport os  # local import \u2013 keep\t\n",
      "utf-8",
    );

    // Patch authored with no trailing whitespace and an ASCII hyphen — only
    // the tolerant matcher (rstrip / fuzzy) can locate the second line.
    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
 import asyncio
-import os  # local import - keep
+import os  # HELLO
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe(
      "import asyncio\nimport os  # HELLO\n",
    );
  });

  it("apply_patch uses @@ <header> as a pre-seek anchor for non-unique context", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "Dup.ts");
    await writeFile(
      filePath,
      "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n",
      "utf-8",
    );

    // Both functions return the same line; the @@ header line ("function b() {")
    // disambiguates by advancing the cursor past the second declaration.
    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@ function b() {
-  return 1;
+  return 2;
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe(
      "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n",
    );
  });

  it("apply_patch supports pure-addition hunks at end of file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "log.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
+gamma
*** End of File
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("apply_patch allows the first chunk to omit the @@ header", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "first.py");
    await writeFile(filePath, "import foo\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
 import foo
+import bar
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("import foo\nimport bar\n");
  });

  it("apply_patch unwraps a heredoc-wrapped envelope", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "wrap.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch({
      input: `<<EOF
*** Begin Patch
*** Update File: ${filePath}
@@
 hello
-world
+stella
*** End Patch
EOF`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch applies multiple chunks and preserves order via reverse-apply", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "multi.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\nf\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("a\nB\nc\nd\nE\nf\ng\n");
  });

  it("apply_patch returns a clear error when context cannot be located", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "miss.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
-gamma
+delta
*** End Patch`,
    });

    expect(result.error).toMatch(
      /failed to find expected lines in .*miss\.txt:\s*gamma/,
    );
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

  it("exec_command payload reports wall_time_seconds and original_token_count", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        // Emit ~6KB of output, well above the small budget below so we trigger truncation.
        cmd: 'printf %.0s_ {1..6000}; echo done',
        yield_time_ms: 1000,
        max_output_tokens: 256,
      },
      { conversationId: "c1", deviceId: "d1", requestId: "r1", stellaRoot: root },
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as Record<string, unknown>;
    expect(typeof payload.wall_time_seconds).toBe("number");
    expect(payload.wall_time_seconds as number).toBeGreaterThanOrEqual(0);
    expect(typeof payload.original_token_count).toBe("number");
    expect(payload.original_token_count as number).toBeGreaterThan(256);
  });

  it("exec_command payload includes original_token_count even when output is small", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf ok",
        yield_time_ms: 1000,
      },
      { conversationId: "c1", deviceId: "d1", requestId: "r1", stellaRoot: root },
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as Record<string, unknown>;
    expect(payload.output).toBe("ok");
    expect(typeof payload.original_token_count).toBe("number");
    expect((payload.original_token_count as number) >= 1).toBe(true);
  });

  it("multi_tool_use.parallel rejects write_stdin (non-parallel-safe)", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaRoot: root });

    try {
      const result = await host.executeTool(
        "multi_tool_use.parallel",
        {
          tool_uses: [
            {
              recipient_name: "write_stdin",
              parameters: { session_id: "s1", chars: "" },
            },
            {
              recipient_name: "write_stdin",
              parameters: { session_id: "s1", chars: "" },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaRoot: root,
          allowedToolNames: ["write_stdin", "multi_tool_use.parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      const text = String(result.result ?? "");
      expect(text).toContain(
        "write_stdin is not safe to run inside multi_tool_use.parallel",
      );
    } finally {
      await host.shutdown();
    }
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
