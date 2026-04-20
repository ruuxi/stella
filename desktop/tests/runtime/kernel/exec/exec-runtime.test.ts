import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExecHost } from "../../../../../runtime/kernel/exec/exec-host.js";
import { createExecToolRegistry } from "../../../../../runtime/kernel/tools/registry/registry.js";
import {
  createApplyPatchBuiltin,
  createFileBuiltins,
} from "../../../../../runtime/kernel/tools/registry/builtins/index.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const createTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stella-exec-"));
  tempDirs.push(dir);
  return dir;
};

const ctx: ToolContext = {
  conversationId: "c",
  deviceId: "d",
  requestId: "r",
  storageMode: "local",
};

describe("Exec runtime", () => {
  it("runs a simple program and returns a JSON value", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "sum",
        source: `
          const values = [1, 2, 3];
          return { total: values.reduce((sum, v) => sum + v, 0) };
        `,
        context: ctx,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.value).toEqual({ total: 6 });
    } finally {
      await host.shutdown();
    }
  });

  it("invokes registered tools.* entries via the worker", async () => {
    const dir = createTempDir();
    const target = path.join(dir, "hello.txt");
    writeFileSync(target, "hi", "utf-8");

    const registry = createExecToolRegistry([
      ...createFileBuiltins(),
      createApplyPatchBuiltin(),
    ]);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "read and patch",
        source: `
          const file = await tools.read_file({ path: ${JSON.stringify(target)} });
          await tools.apply_patch({
            patch: [
              "*** Begin Patch",
              "*** Update File: ${target}",
              "@@",
              "-hi",
              "+hello",
              "*** End Patch",
              "",
            ].join("\\n"),
          });
          return { original: file.content };
        `,
        context: ctx,
      });
      if (result.kind === "failed") {
        throw new Error(`Exec failed: ${result.message}`);
      }
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.value).toEqual({ original: "hi" });
      expect(readFileSync(target, "utf-8")).toBe("hello");
    } finally {
      await host.shutdown();
    }
  });

  it("preserves cross-call state via store/load", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      await host.execute({
        summary: "store",
        source: `
          store("greeting", "hello");
          return "stored";
        `,
        context: ctx,
      });
      const second = await host.execute({
        summary: "load",
        source: `
          return load("greeting");
        `,
        context: ctx,
      });
      expect(second.kind).toBe("completed");
      if (second.kind !== "completed") return;
      expect(second.value).toBe("hello");
    } finally {
      await host.shutdown();
    }
  });

  it("forwards text() and image() into the result content", async () => {
    const dir = createTempDir();
    const imagePath = path.join(dir, "px.png");
    // 1x1 transparent PNG.
    writeFileSync(
      imagePath,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
        "hex",
      ),
    );
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "vision",
        source: `
          text("hello");
          await image(${JSON.stringify(imagePath)});
          return "done";
        `,
        context: ctx,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.content[0]).toEqual({ type: "text", text: "hello" });
      expect(result.content[1]?.type).toBe("image");
      if (result.content[1]?.type === "image") {
        expect(result.content[1].mimeType).toBe("image/png");
        expect(result.content[1].data.length).toBeGreaterThan(0);
      }
    } finally {
      await host.shutdown();
    }
  });

  it("rejects static import syntax with a helpful error", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "bad import",
        source: `
          import fs from "node:fs";
          return fs.readdirSync(".");
        `,
        context: ctx,
      });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.message).toMatch(/Static import\/export are not supported/);
    } finally {
      await host.shutdown();
    }
  });

  it("yields via // @exec: yield_after_ms and resumes on Wait", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const yielded = await host.execute({
        summary: "long-running",
        source: `
          // @exec: yield_after_ms=50
          await new Promise((resolve) => setTimeout(resolve, 200));
          return "completed";
        `,
        context: ctx,
      });
      expect(yielded.kind).toBe("yielded");
      if (yielded.kind !== "yielded") return;
      const resumed = await host.wait({
        cellId: yielded.cellId,
        yieldAfterMs: 5_000,
      });
      expect(resumed.kind).toBe("completed");
      if (resumed.kind !== "completed") return;
      expect(resumed.value).toBe("completed");
    } finally {
      await host.shutdown();
    }
  });
});
