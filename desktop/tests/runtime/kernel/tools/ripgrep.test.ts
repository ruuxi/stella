import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  clearRipgrepPathCacheForTests,
  resolveRipgrepPath,
} from "../../../../../runtime/kernel/tools/ripgrep";

describe("ripgrep resolver", () => {
  const originalPath = process.env.PATH;
  const originalStellaAppDir = process.env.STELLA_APP_DIR;
  const originalStellaDataDir = process.env.STELLA_DATA_DIR;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalStellaAppDir === undefined) {
      delete process.env.STELLA_APP_DIR;
    } else {
      process.env.STELLA_APP_DIR = originalStellaAppDir;
    }
    if (originalStellaDataDir === undefined) {
      delete process.env.STELLA_DATA_DIR;
    } else {
      process.env.STELLA_DATA_DIR = originalStellaDataDir;
    }
    clearRipgrepPathCacheForTests();
  });

  it("copies bundled rg into Stella-private bin when system rg is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-rg-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "stella-rg-home-"));
    const source = path.join(root, "node_modules", ".bin", "rg");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "#!/bin/sh\necho bundled-rg\n", { mode: 0o755 });
    process.env.PATH = "";
    delete process.env.STELLA_APP_DIR;
    delete process.env.STELLA_DATA_DIR;

    const resolved = await resolveRipgrepPath({
      conversationId: "c",
      deviceId: "d",
      requestId: "r",
      stellaAppDir: root,
      stellaDataDir: home,
    });

    const target = path.join(home, "bin", "rg");
    expect(resolved).toBe(target);
    expect((await stat(target)).mode & 0o111).not.toBe(0);
    await expect(readFile(target, "utf8")).resolves.toContain("bundled-rg");
  });
});
