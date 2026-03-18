import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySessionFileOp,
  ensurePathWithinRoot,
  normalizeSessionRelativePath,
  resolveSessionLocalFolder,
  sanitizeSessionFolderLabel,
  scanSessionWorkspace,
} from "../../../electron/services/social-session-fs.js";

const tempRoots: string[] = [];

const createTempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-social-session-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("social-session-fs", () => {
  it("normalizes safe relative paths and rejects traversal", () => {
    expect(normalizeSessionRelativePath(" src\\\\components / App.tsx ")).toBe(
      "src/components/App.tsx",
    );
    expect(() => normalizeSessionRelativePath("../secrets.txt")).toThrow();
    expect(() => normalizeSessionRelativePath("./notes.txt")).toThrow();
  });

  it("sanitizes local folder names for cross-platform safety", () => {
    expect(sanitizeSessionFolderLabel('  Team<Alpha>:/Sprint?1...  ')).toBe(
      "Team-Alpha---Sprint-1",
    );
    expect(
      resolveSessionLocalFolder("C:\\workspace", "session-abcdef12", "CON"),
    ).toContain("CON-session-session-");
  });

  it("writes, scans, and deletes workspace files inside the session root", async () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    await applySessionFileOp({
      rootPath: workspaceRoot,
      type: "upsert",
      relativePath: "src/App.tsx",
      bytes: new TextEncoder().encode("export const App = () => null;\n"),
    });

    const absolutePath = ensurePathWithinRoot(workspaceRoot, "src/App.tsx");
    expect(fs.existsSync(absolutePath)).toBe(true);

    const scanned = await scanSessionWorkspace(workspaceRoot);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.relativePath).toBe("src/App.tsx");
    expect(scanned[0]?.contentHash).toHaveLength(64);

    await applySessionFileOp({
      rootPath: workspaceRoot,
      type: "delete",
      relativePath: "src/App.tsx",
    });

    expect(fs.existsSync(absolutePath)).toBe(false);
  });
});
