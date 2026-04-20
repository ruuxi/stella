import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchBuiltin } from "../../../../../runtime/kernel/tools/registry/builtins/apply-patch.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const createTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stella-apply-patch-"));
  tempDirs.push(dir);
  return dir;
};

const ctx: ToolContext = {
  conversationId: "c",
  deviceId: "d",
  requestId: "r",
  storageMode: "local",
};

const apply = async (patch: string) => {
  const tool = createApplyPatchBuiltin();
  return await tool.handler({ patch }, ctx, { cellId: "test" });
};

describe("apply_patch builtin", () => {
  it("creates new files via *** Add File", async () => {
    const dir = createTempDir();
    const target = path.join(dir, "subdir", "hello.txt");
    const result = (await apply(
      `*** Begin Patch\n*** Add File: ${target}\n+Hello\n+World\n*** End Patch\n`,
    )) as { results: Array<{ kind: string; path: string }> };
    expect(result.results[0]).toEqual({ kind: "add", path: target });
    expect(readFileSync(target, "utf-8")).toBe("Hello\nWorld\n");
  });

  it("updates existing files via *** Update File hunks", async () => {
    const dir = createTempDir();
    const target = path.join(dir, "code.ts");
    writeFileSync(
      target,
      "const greeting = 'hi';\nconsole.log(greeting);\nexport {};\n",
      "utf-8",
    );
    await apply(
      [
        "*** Begin Patch",
        `*** Update File: ${target}`,
        "@@",
        " const greeting = 'hi';",
        "-console.log(greeting);",
        "+console.warn(greeting.toUpperCase());",
        " export {};",
        "*** End Patch",
        "",
      ].join("\n"),
    );
    expect(readFileSync(target, "utf-8")).toBe(
      "const greeting = 'hi';\nconsole.warn(greeting.toUpperCase());\nexport {};\n",
    );
  });

  it("supports *** Move to renames in updates", async () => {
    const dir = createTempDir();
    const original = path.join(dir, "old.ts");
    const renamed = path.join(dir, "renamed", "new.ts");
    writeFileSync(original, "value;\n", "utf-8");
    mkdirSync(path.dirname(renamed), { recursive: true });
    await apply(
      [
        "*** Begin Patch",
        `*** Update File: ${original}`,
        `*** Move to: ${renamed}`,
        "@@",
        "-value;",
        "+nextValue;",
        "*** End Patch",
        "",
      ].join("\n"),
    );
    expect(existsSync(original)).toBe(false);
    expect(readFileSync(renamed, "utf-8")).toBe("nextValue;\n");
  });

  it("deletes files via *** Delete File", async () => {
    const dir = createTempDir();
    const target = path.join(dir, "obsolete.md");
    writeFileSync(target, "bye", "utf-8");
    await apply(
      `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch\n`,
    );
    expect(existsSync(target)).toBe(false);
  });

  it("rejects relative paths", async () => {
    await expect(
      apply(
        `*** Begin Patch\n*** Add File: not/absolute.txt\n+contents\n*** End Patch\n`,
      ),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects malformed patches", async () => {
    await expect(apply(`not a patch`)).rejects.toThrow();
  });

  it("returns a clear error when an Update hunk doesn't match", async () => {
    const dir = createTempDir();
    const target = path.join(dir, "code.ts");
    writeFileSync(target, "alpha\nbeta\n", "utf-8");
    await expect(
      apply(
        [
          "*** Begin Patch",
          `*** Update File: ${target}`,
          "@@",
          "-zeta",
          "+omega",
          "*** End Patch",
          "",
        ].join("\n"),
      ),
    ).rejects.toThrow(/locate hunk/);
  });
});
