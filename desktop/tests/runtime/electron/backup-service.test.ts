import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService } from "../../../electron/services/backup-service.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("BackupService restore", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("restores state entries using the manifest scope, not the state root basename", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stella-backup-"));
    tempRoots.push(tempRoot);

    const stateRoot = path.join(tempRoot, ".stella");
    const stagedObjectsDir = path.join(tempRoot, "objects");
    await fs.mkdir(stagedObjectsDir, { recursive: true });
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(path.join(stateRoot, "preferences.json"), "old", "utf-8");

    const objectId = "preferences-object";
    const restoredContent = "restored";
    await fs.writeFile(path.join(stagedObjectsDir, objectId), restoredContent, "utf-8");

    const service = new BackupService({
      stellaRoot: tempRoot,
      getStellaRoot: () => tempRoot,
      getStellaStatePath: () => stateRoot,
      getRunner: () => null,
      getAuthToken: async () => null,
      getConvexSiteUrl: () => null,
      getDeviceId: () => "device",
      processRuntime: {
        setManagedTimeout: () => () => {},
        setManagedInterval: () => () => {},
      },
    } as never);

    await (
      service as unknown as {
        restoreScopedDirectory: (args: {
          rootPath: string;
          scope: "state";
          entries: Array<{
            scope: "state";
            path: string;
            sha256: string;
            objectId: string;
            size: number;
          }>;
          stagedObjectsDir: string;
          shouldSkip: (relativePath: string, isDirectory: boolean) => boolean;
        }) => Promise<void>;
      }
    ).restoreScopedDirectory({
      rootPath: stateRoot,
      scope: "state",
      entries: [
        {
          scope: "state",
          path: "state/preferences.json",
          sha256: sha256(restoredContent),
          objectId,
          size: restoredContent.length,
        },
      ],
      stagedObjectsDir,
      shouldSkip: () => false,
    });

    await expect(fs.readFile(path.join(stateRoot, "preferences.json"), "utf-8")).resolves.toBe(restoredContent);
    await expect(fs.stat(path.join(stateRoot, "eferences.json"))).rejects.toThrow();
  });
});
