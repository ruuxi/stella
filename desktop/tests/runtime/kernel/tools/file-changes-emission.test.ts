import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleEdit,
  handleWrite,
} from "../../../../../runtime/kernel/tools/file.js";
import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-file-changes-"));
  tempDirs.push(dir);
  return dir;
};

describe("fileChanges emission", () => {
  it("Write emits an `add` change for a brand-new file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "new", "fresh.txt");

    const result = await handleWrite({ file_path: filePath, content: "hi" });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
    expect(await readFile(filePath, "utf-8")).toBe("hi");
  });

  it("Write emits an `update` change when the file already existed", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "existing.txt");
    await writeFile(filePath, "old", "utf-8");

    const result = await handleWrite({ file_path: filePath, content: "new" });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "update" } },
    ]);
  });

  it("Write does not emit fileChanges on error", async () => {
    const result = await handleWrite({
      file_path: "",
      content: "irrelevant",
    });
    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });

  it("Edit emits an `update` change for a successful replacement", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "edit-me.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");

    const result = await handleEdit({
      file_path: filePath,
      old_string: "beta",
      new_string: "BETA",
    });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "update" } },
    ]);
  });

  it("Edit returns no fileChanges when the replacement fails", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "edit-me.txt");
    await writeFile(filePath, "alpha\n", "utf-8");

    const result = await handleEdit({
      file_path: filePath,
      old_string: "missing",
      new_string: "x",
    });

    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });

  it("apply_patch emits one fileChange per parsed op (add / update / delete)", async () => {
    const root = await createTempDir();
    const updatePath = path.join(root, "update.txt");
    const deletePath = path.join(root, "delete.txt");
    const addPath = path.join(root, "add.txt");
    await writeFile(updatePath, "old\n", "utf-8");
    await writeFile(deletePath, "bye\n", "utf-8");

    const patch = `*** Begin Patch
*** Update File: ${updatePath}
@@
-old
+new
*** Delete File: ${deletePath}
*** Add File: ${addPath}
+hello world
*** End Patch`;

    const result = await handleApplyPatch({ input: patch });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: updatePath, kind: { type: "update" } },
      { path: deletePath, kind: { type: "delete" } },
      { path: addPath, kind: { type: "add" } },
    ]);
  });

  it("apply_patch carries `move_path` when an Update has a Move to header", async () => {
    const root = await createTempDir();
    const fromPath = path.join(root, "from.txt");
    const toPath = path.join(root, "renamed", "to.txt");
    await writeFile(fromPath, "alpha\nbeta\n", "utf-8");

    const patch = `*** Begin Patch
*** Update File: ${fromPath}
*** Move to: ${toPath}
@@
 alpha
-beta
+BETA
*** End Patch`;

    const result = await handleApplyPatch({ input: patch });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      {
        path: fromPath,
        kind: { type: "update", move_path: toPath },
      },
    ]);
  });

  it("apply_patch returns no fileChanges when parsing fails", async () => {
    const result = await handleApplyPatch({
      input: "this is not a patch envelope",
    });
    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });
});
