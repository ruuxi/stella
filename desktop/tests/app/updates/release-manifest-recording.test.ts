import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAppliedReleaseManifest } from "../../../electron/ipc/updates-handlers.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("writeAppliedReleaseManifest", () => {
  it("updates the local schema-v1 release marker after a Git update", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stella-release-record-"),
    );
    roots.add(root);
    await writeFile(
      path.join(root, "stella-release.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        tag: "desktop-v1.2.2",
        version: "1.2.2",
        platform: "darwin-arm64",
        commit: "a".repeat(40),
        files: {},
      })}\n`,
    );
    const commit = "b".repeat(40);

    await expect(
      writeAppliedReleaseManifest(root, commit, "desktop-v1.2.3"),
    ).resolves.toBe(true);

    await expect(
      readFile(path.join(root, "stella-release.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      tag: "desktop-v1.2.3",
      version: "1.2.3",
      platform: "darwin-arm64",
      commit,
      files: {},
    });
  });
});
