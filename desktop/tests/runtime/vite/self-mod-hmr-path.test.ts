import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveSelfModHmrAbsolutePath,
  resolveSelfModOverlayImportPath,
  shouldPromoteSuppressedShellUpdatePath,
  shouldParkSelfModHmrClientUpdates,
} from "../../../vite.config";

const repoRoot = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
  .replace(/\\/g, "/");

describe("resolveSelfModHmrAbsolutePath", () => {
  it("resolves repo-relative paths inside the repo", () => {
    expect(resolveSelfModHmrAbsolutePath("desktop/src/app.tsx")).toBe(
      path.resolve(repoRoot, "desktop/src/app.tsx").replace(/\\/g, "/"),
    );
  });

  it("rejects absolute paths and parent-directory escapes", () => {
    expect(resolveSelfModHmrAbsolutePath("/tmp/outside.ts")).toBeNull();
    expect(resolveSelfModHmrAbsolutePath("../outside.ts")).toBeNull();
    expect(resolveSelfModHmrAbsolutePath("desktop/../../outside.ts")).toBeNull();
  });
});

describe("resolveSelfModOverlayImportPath", () => {
  it("resolves extensionless overlay-owned imports even when disk is missing", () => {
    const importer = path.resolve(repoRoot, "desktop/src/App.tsx");
    const target = path.resolve(repoRoot, "desktop/src/new-module.tsx").replace(/\\/g, "/");

    expect(
      resolveSelfModOverlayImportPath("./new-module", importer, (absPath) =>
        absPath === target,
      ),
    ).toBe(target);
  });

  it("resolves overlay-owned index imports", () => {
    const importer = path.resolve(repoRoot, "desktop/src/App.tsx");
    const target = path.resolve(repoRoot, "desktop/src/new-panel/index.tsx").replace(/\\/g, "/");

    expect(
      resolveSelfModOverlayImportPath("./new-panel", importer, (absPath) =>
        absPath === target,
      ),
    ).toBe(target);
  });

  it("rejects non-renderer and package imports", () => {
    const importer = path.resolve(repoRoot, "desktop/src/App.tsx");
    const packageJson = path.resolve(repoRoot, "package.json").replace(/\\/g, "/");

    expect(
      resolveSelfModOverlayImportPath("../../package.json", importer, (absPath) =>
        absPath === packageJson,
      ),
    ).toBeNull();
    expect(
      resolveSelfModOverlayImportPath("react", importer, () => true),
    ).toBeNull();
  });
});

describe("shouldPromoteSuppressedShellUpdatePath", () => {
  it("ignores suppressed shell updates when disk content still matches the pre-command snapshot", () => {
    expect(
      shouldPromoteSuppressedShellUpdatePath(
        "export const value = 'before';\n",
        "export const value = 'before';\n",
      ),
    ).toBe(false);
  });

  it("promotes suppressed shell updates when disk content differs from the pre-command snapshot", () => {
    expect(
      shouldPromoteSuppressedShellUpdatePath(
        "export const value = 'before';\n",
        "export const value = 'after';\n",
      ),
    ).toBe(true);
  });

  it("promotes newly-created files but ignores missing files without a snapshot", () => {
    expect(shouldPromoteSuppressedShellUpdatePath(undefined, "new file\n")).toBe(
      true,
    );
    expect(shouldPromoteSuppressedShellUpdatePath(undefined, "")).toBe(false);
  });
});

describe("shouldParkSelfModHmrClientUpdates", () => {
  it("parks client updates by default and keeps live mode as the dev escape hatch", () => {
    expect(shouldParkSelfModHmrClientUpdates(undefined)).toBe(true);
    expect(shouldParkSelfModHmrClientUpdates("")).toBe(true);
    expect(shouldParkSelfModHmrClientUpdates("live")).toBe(false);
    expect(shouldParkSelfModHmrClientUpdates(" LIVE ")).toBe(false);
  });
});
