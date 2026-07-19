import path from "node:path";
import { promises as fsp } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleEdit,
  handleWrite,
  replaceTextInFile,
} from "../../../../../runtime/kernel/tools/file.js";
import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";
import {
  pendingFileWriteLockCount,
  withFileWriteLock,
  withFileWriteLocks,
  writeFileAtomicWithVerify,
  writeFileWithNulGuard,
} from "../../../../../runtime/kernel/tools/file-write-lock.js";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const createTempDir = async () => {
  return await tempDirs.create("stella-file-write-lock-");
};

describe("withFileWriteLock", () => {
  it("serializes critical sections targeting the same path", async () => {
    const events: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await Promise.all(
      [30, 20, 10, 0].map((delay, i) =>
        withFileWriteLock("/tmp/same-target.txt", async () => {
          events.push(`start-${i}`);
          await sleep(delay);
          events.push(`end-${i}`);
        }),
      ),
    );

    // Every section must complete before the next one starts (FIFO order).
    expect(events).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
    expect(pendingFileWriteLockCount()).toBe(0);
  });

  it("keeps different paths independent (cross-file parallelism)", async () => {
    let releaseA: () => void = () => {};
    const blockA = new Promise<void>((r) => {
      releaseA = r;
    });

    let bRan = false;
    const a = withFileWriteLock("/tmp/parallel-a.txt", () => blockA);
    const b = withFileWriteLock("/tmp/parallel-b.txt", async () => {
      bRan = true;
    });

    await b;
    expect(bRan).toBe(true); // B finished while A's lock is still held.
    releaseA();
    await a;
  });

  it("keeps the queue alive after a holder throws", async () => {
    const key = "/tmp/throwing-holder.txt";
    const first = withFileWriteLock(key, async () => {
      throw new Error("boom");
    });
    const second = withFileWriteLock(key, async () => "ok");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("treats path variants of the same file as one lock", async () => {
    const events: string[] = [];
    await Promise.all([
      withFileWriteLock("/tmp/foo/../variant.txt", async () => {
        events.push("first");
        await new Promise((r) => setTimeout(r, 15));
        events.push("first-done");
      }),
      withFileWriteLock("/tmp/variant.txt", async () => {
        events.push("second");
      }),
    ]);
    expect(events).toEqual(["first", "first-done", "second"]);
  });

  it("acquires multi-path locks without deadlocking on order", async () => {
    const results = await Promise.all([
      withFileWriteLocks(["/tmp/m-a.txt", "/tmp/m-b.txt"], async () => "ab"),
      withFileWriteLocks(["/tmp/m-b.txt", "/tmp/m-a.txt"], async () => "ba"),
    ]);
    expect(results.sort()).toEqual(["ab", "ba"]);
  });
});

describe("concurrent Edit stress", () => {
  it("lands every parallel edit; content equals sequential application", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "stress.txt");
    const count = 40;
    const lines = Array.from({ length: count }, (_, i) => `line-${i}-old`);
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        handleEdit({
          file_path: filePath,
          old_string: `line-${i}-old`,
          new_string: `line-${i}-new`,
        }),
      ),
    );

    for (const result of results) {
      expect(result.error).toBeUndefined();
    }

    const expected =
      Array.from({ length: count }, (_, i) => `line-${i}-new`).join("\n") +
      "\n";
    expect(await readFile(filePath, "utf-8")).toBe(expected);
  });

  it("serializes mixed Edit + Write + apply_patch on one file", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "mixed.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");

    const [editResult, patchResult] = await Promise.all([
      handleEdit({
        file_path: filePath,
        old_string: "alpha",
        new_string: "ALPHA",
      }),
      handleApplyPatch({
        input: [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-gamma",
          "+GAMMA",
          "*** End Patch",
        ].join("\n"),
      }),
    ]);

    expect(editResult.error).toBeUndefined();
    expect(patchResult.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  it("edits to different files still run and land in parallel", async () => {
    const dir = await createTempDir();
    const files = Array.from({ length: 8 }, (_, i) =>
      path.join(dir, `parallel-${i}.txt`),
    );
    await Promise.all(
      files.map((f, i) => writeFile(f, `content-${i}-old\n`, "utf-8")),
    );

    const results = await Promise.all(
      files.map((f, i) =>
        replaceTextInFile({
          filePath: f,
          oldString: `content-${i}-old`,
          newString: `content-${i}-new`,
        }),
      ),
    );

    expect(results.map((r) => r.replacements)).toEqual(files.map(() => 1));
    for (const [i, f] of files.entries()) {
      expect(await readFile(f, "utf-8")).toBe(`content-${i}-new\n`);
    }
  });

  it("parallel Write calls to one file leave exactly one full payload", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "write-race.txt");
    const payloads = Array.from({ length: 10 }, (_, i) =>
      `payload-${i}\n`.repeat(50),
    );

    const results = await Promise.all(
      payloads.map((content) => handleWrite({ file_path: filePath, content })),
    );
    for (const result of results) {
      expect(result.error).toBeUndefined();
    }

    const final = await readFile(filePath, "utf-8");
    expect(payloads).toContain(final); // one intact payload, no interleaving
    expect(final.includes("\u0000")).toBe(false);
  });
});

describe("writeFileWithNulGuard", () => {
  it("writes clean content without complaint", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "clean.txt");
    await writeFileWithNulGuard(filePath, "hello\n");
    expect(await readFile(filePath, "utf-8")).toBe("hello\n");
  });

  it("allows NUL bytes that were part of the intended content", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "intended-nul.txt");
    await writeFileWithNulGuard(filePath, "a\u0000b");
    expect(await readFile(filePath, "utf-8")).toBe("a\u0000b");
  });

  it("fires loudly and repairs injected NUL corruption", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "corrupted.txt");

    const realWriteFile = fsp.writeFile;
    let corrupted = false;
    const spy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementation(async (target, data, options) => {
        await realWriteFile(target, data as string, options as never);
        if (!corrupted && target === filePath) {
          corrupted = true;
          // Simulate the observed corruption: NUL-padded tail.
          await realWriteFile(
            target,
            String(data) + "\u0000\u0000\u0000\u0000",
            "utf-8",
          );
        }
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFileWithNulGuard(filePath, "intact\n");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("NUL-byte corruption detected"),
      );
      expect(await readFile(filePath, "utf-8")).toBe("intact\n");
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("throws when corruption persists past the retry", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "persistent.txt");

    const realWriteFile = fsp.writeFile;
    const spy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementation(async (target, data, options) => {
        const payload =
          target === filePath ? String(data) + "\u0000\u0000" : (data as string);
        await realWriteFile(target, payload, options as never);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(writeFileWithNulGuard(filePath, "x\n")).rejects.toThrow(
        /NUL bytes/,
      );
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("fires loudly and repairs a non-NUL read-back mismatch (equality, not just NUL absence)", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "truncated.txt");

    const realWriteFile = fsp.writeFile;
    let corrupted = false;
    const spy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementation(async (target, data, options) => {
        await realWriteFile(target, data as string, options as never);
        if (!corrupted && target === filePath) {
          corrupted = true;
          // Simulate a truncating corruption with no NUL bytes at all —
          // the class the original NUL-absence check waved through.
          await realWriteFile(target, String(data).slice(0, 3), "utf-8");
        }
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFileWithNulGuard(filePath, "intact content\n");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("read-back mismatch"),
      );
      expect(await readFile(filePath, "utf-8")).toBe("intact content\n");
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("accepts content with a lone UTF-16 surrogate (compares against the UTF-8 on-disk intent)", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "lone-surrogate.txt");
    // Legal in JS strings (model-generated tool args can carry it); UTF-8
    // encodes it as U+FFFD, so raw-string equality would report this
    // landed write as persistent corruption.
    const content = 'prefix "\uD800" suffix\n';
    await writeFileWithNulGuard(filePath, content);
    expect(await readFile(filePath, "utf-8")).toBe('prefix "�" suffix\n');
  });

  it("throws on a persistent non-NUL mismatch", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "persistent-mismatch.txt");

    const realWriteFile = fsp.writeFile;
    const spy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementation(async (target, data, options) => {
        const payload =
          target === filePath ? String(data).slice(0, 2) : (data as string);
        await realWriteFile(target, payload, options as never);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(writeFileWithNulGuard(filePath, "abcdef\n")).rejects.toThrow(
        /do not match the intended content/,
      );
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("writeFileAtomicWithVerify", () => {
  it("replaces existing content and leaves no temp file behind", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "target.md");
    await writeFile(filePath, "old bytes\n", "utf-8");

    await writeFileAtomicWithVerify(filePath, "new bytes\n");

    expect(await readFile(filePath, "utf-8")).toBe("new bytes\n");
    const names = await fsp.readdir(dir);
    expect(names).toEqual(["target.md"]);
  });

  it("creates a missing target", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "fresh.md");
    await writeFileAtomicWithVerify(filePath, "hello\n");
    expect(await readFile(filePath, "utf-8")).toBe("hello\n");
  });

  it("accepts content with a lone UTF-16 surrogate", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "surrogate.md");
    await writeFileAtomicWithVerify(filePath, "a \uDC00 b\n");
    expect(await readFile(filePath, "utf-8")).toBe("a � b\n");
    expect(await fsp.readdir(dir)).toEqual(["surrogate.md"]);
  });

  it("keeps the original bytes intact and cleans up the temp file when the rename fails", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "protected.md");
    await writeFile(filePath, "must survive\n", "utf-8");

    const realRename = fsp.rename;
    const spy = vi
      .spyOn(fsp, "rename")
      .mockImplementation(async (from, to) => {
        if (String(to) === filePath) {
          throw new Error("injected rename failure");
        }
        return realRename(from as never, to as never);
      });

    try {
      await expect(
        writeFileAtomicWithVerify(filePath, "replacement\n"),
      ).rejects.toThrow("injected rename failure");
    } finally {
      spy.mockRestore();
    }

    // The crash-window guarantee: old file whole, no dot-tmp litter.
    expect(await readFile(filePath, "utf-8")).toBe("must survive\n");
    const names = await fsp.readdir(dir);
    expect(names).toEqual(["protected.md"]);
  });
});
