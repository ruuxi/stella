import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  activateStagedStellaBrowserBinary,
  resolveStellaBrowserBinaryPath,
} from "../../electron/utils/stella-browser-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const binaryName = () => {
  if (process.platform === "darwin") {
    return `stella-browser-darwin-${process.arch}`;
  }
  if (process.platform === "win32") return "stella-browser-win32-x64.exe";
  return `stella-browser-linux-${process.arch}`;
};

describe("activateStagedStellaBrowserBinary", () => {
  it("atomically promotes the staged updater artifact and removes its backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-browser-root-"));
    roots.push(root);
    const platformKey =
      process.platform === "win32"
        ? "win-x64"
        : `${process.platform}-${process.arch}`;
    const binaryPath = path.join(
      root,
      "out",
      platformKey,
      process.platform === "win32" ? "stella-browser.exe" : "stella-browser",
    );
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, "old");
    await writeFile(`${binaryPath}.update`, "new");
    await writeFile(`${binaryPath}.previous`, "stale-backup");

    expect(activateStagedStellaBrowserBinary(root)).toBe(true);
    await expect(readFile(binaryPath, "utf8")).resolves.toBe("new");
    await expect(
      readFile(`${binaryPath}.update`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(`${binaryPath}.previous`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(activateStagedStellaBrowserBinary(root)).toBe(false);
  });

  it("prefers the hydrated artifact and falls back to the legacy tracked binary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-browser-root-"));
    roots.push(root);
    const legacyPath = path.join(root, "bin", binaryName());
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "legacy");
    expect(resolveStellaBrowserBinaryPath(root)).toBe(legacyPath);

    const platformKey =
      process.platform === "win32"
        ? "win-x64"
        : `${process.platform}-${process.arch}`;
    const hydratedPath = path.join(
      root,
      "out",
      platformKey,
      process.platform === "win32" ? "stella-browser.exe" : "stella-browser",
    );
    await mkdir(path.dirname(hydratedPath), { recursive: true });
    await writeFile(hydratedPath, "hydrated");
    expect(resolveStellaBrowserBinaryPath(root)).toBe(hydratedPath);
  });
});
