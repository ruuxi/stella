import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isHmrPathUnderDirectory,
  resolveHmrToolTargetPath,
} from "../../../../../runtime/kernel/runner/agent-orchestration.js";

describe("task-orchestration HMR target resolution", () => {
  const stellaRoot = path.resolve("/tmp/stella-root");

  it("resolves explicit exec_command file targets", () => {
    const targetPath = resolveHmrToolTargetPath(
      "exec_command",
      {
        cmd: "echo hi > desktop/src/app.tsx",
        workdir: stellaRoot,
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve(stellaRoot, "desktop/src/app.tsx"));
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("does not mark non-stella working directories as in-repo", () => {
    const targetPath = resolveHmrToolTargetPath(
      "exec_command",
      {
        cmd: "bun install",
        workdir: "/tmp",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve("/tmp"));
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(false);
  });

  it("ignores safe read-only exec_command calls", () => {
    const targetPath = resolveHmrToolTargetPath(
      "exec_command",
      {
        cmd: "git status",
        workdir: stellaRoot,
      },
      stellaRoot,
    );

    expect(targetPath).toBeNull();
  });

  it("infers apply_patch target paths directly", () => {
    const expandedTmpRoot = path.resolve(os.tmpdir(), "stella-root");
    const targetPath = resolveHmrToolTargetPath(
      "apply_patch",
      {
        patch: `*** Begin Patch
*** Update File: ${path.resolve(stellaRoot, "desktop/src/app.tsx")}
@@
-old
+new
*** End Patch`,
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve(expandedTmpRoot, "desktop/src/app.tsx"));
  });

  it("cannot infer shell writes without a stella root fallback", () => {
    const targetPath = resolveHmrToolTargetPath("exec_command", {
      cmd: "echo hi",
    });

    expect(targetPath).toBeNull();
  });
});
