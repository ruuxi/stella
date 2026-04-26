import os from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDeferredDeletePaths,
  purgeExpiredDeferredDeletes,
  trashPathsForDeferredDelete,
} from "../../../../../runtime/kernel/tools/deferred-delete.js";
import {
  extractNativeWindowsDeleteTargets,
  extractPowerShellDeleteTargets,
  extractWindowsCmdDeleteTargets,
} from "../../../../../runtime/kernel/tools/deferred-delete-cli.js";
import {
  createShellState,
  handleExecCommand,
} from "../../../../../runtime/kernel/tools/shell.js";

const tempDirs: string[] = [];
const originalPlatform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-deferred-delete-"));
  tempDirs.push(dir);
  return dir;
};

const forcePlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
};

describe("deferred-delete trash", () => {
  it("moves deleted files into Stella trash with 24h metadata", async () => {
    const stellaHome = await createTempDir();
    const target = path.join(stellaHome, "victim.txt");
    await writeFile(target, "keep me for now", "utf-8");

    const result = await trashPathsForDeferredDelete([target], {
      source: "test",
      stellaHome,
    });

    expect(result.errors).toEqual([]);
    expect(result.trashed).toHaveLength(1);
    await expect(readFile(target, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(result.trashed[0]!.trashPath, "utf-8")).toBe(
      "keep me for now",
    );
    expect(result.trashed[0]!.purgeAfter - result.trashed[0]!.trashedAt).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("refuses root, home, and system-level directories before deleting", async () => {
    const stellaHome = await createTempDir();
    const result = await trashPathsForDeferredDelete(
      [path.parse(stellaHome).root, os.homedir(), "/System"],
      {
        source: "test",
        stellaHome,
        force: true,
      },
    );

    expect(result.trashed).toEqual([]);
    expect(result.errors.map((error) => error.error)).toEqual([
      "Refusing to delete filesystem root path.",
      "Refusing to delete protected home directory.",
      "Refusing to delete protected system directory.",
    ]);
  });

  it("purges expired trash records and leaves unexpired records alone", async () => {
    const stellaHome = await createTempDir();
    const expired = path.join(stellaHome, "expired.txt");
    const fresh = path.join(stellaHome, "fresh.txt");
    await writeFile(expired, "old", "utf-8");
    await writeFile(fresh, "new", "utf-8");

    const expiredResult = await trashPathsForDeferredDelete([expired], {
      source: "test",
      stellaHome,
    });
    const freshResult = await trashPathsForDeferredDelete([fresh], {
      source: "test",
      stellaHome,
    });

    const now = expiredResult.trashed[0]!.purgeAfter + 1;
    const freshMetadataPath = path.join(
      getDeferredDeletePaths(stellaHome).itemsDir,
      `${freshResult.trashed[0]!.id}.json`,
    );
    const freshRecord = JSON.parse(await readFile(freshMetadataPath, "utf-8"));
    freshRecord.purgeAfter = now + 60_000;
    await writeFile(freshMetadataPath, JSON.stringify(freshRecord), "utf-8");

    const sweep = await purgeExpiredDeferredDeletes({ stellaHome, now });

    expect(sweep).toMatchObject({ checked: 2, purged: 1, skipped: 1 });
    await expect(
      readFile(expiredResult.trashed[0]!.trashPath, "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(freshResult.trashed[0]!.trashPath, "utf-8")).toBe(
      "new",
    );
  });
});

describe("Windows delete interception", () => {
  it("extracts native cmd and PowerShell delete targets", () => {
    expect(extractWindowsCmdDeleteTargets('del /q "old file.txt" & rd /s build')).toEqual([
      "old file.txt",
      "build",
    ]);
    expect(
      extractPowerShellDeleteTargets(
        'Remove-Item -LiteralPath "old file.txt" -Recurse -Force',
      ),
    ).toEqual(["old file.txt"]);
    expect(
      extractNativeWindowsDeleteTargets(
        'del /q "old file.txt"; Remove-Item -Path build -Recurse',
      ),
    ).toEqual(["old file.txt", "build"]);
  });

  it("routes Windows native delete commands to Stella trash instead of cmd.exe", async () => {
    forcePlatform("win32");

    const stellaHome = await createTempDir();
    const stateRoot = path.join(stellaHome, "state");
    await mkdir(stateRoot, { recursive: true });
    const target = path.join(stellaHome, "victim.txt");
    await writeFile(target, "windows delete", "utf-8");

    const shellState = createShellState(stateRoot);
    const result = await handleExecCommand(
      shellState,
      {
        cmd: "del victim.txt",
        workdir: stellaHome,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaRoot: stellaHome,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(
      "Moved 1 item(s) to Stella trash (auto-delete in 24h).",
    );
    await expect(readFile(target, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const trashFiles = await readdir(getDeferredDeletePaths(stellaHome).trashDir);
    expect(trashFiles).toHaveLength(1);
  });
});
