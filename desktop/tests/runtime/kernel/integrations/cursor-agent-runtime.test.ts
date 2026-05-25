import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildCursorPromptFromMessages,
  diffCursorWorktreeSnapshots,
  parseCursorGitStatus,
  snapshotCursorWorktree,
  shouldUseCursorAgentRuntime,
  type CursorWorktreeSnapshot,
} from "../../../../../runtime/kernel/integrations/cursor-agent-runtime.js";

const execFileAsync = promisify(execFile);

const snapshot = (
  status: string,
  fingerprints: Record<string, string | null>,
): CursorWorktreeSnapshot => ({
  repoRoot: "/repo",
  entries: parseCursorGitStatus(status),
  fingerprints: new Map(Object.entries(fingerprints)),
});

describe("Cursor agent runtime", () => {
  it("only routes spawned general agents to Cursor", () => {
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "general",
        agentEngine: "cursor_sdk",
      }),
    ).toBe(true);
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "orchestrator",
        agentEngine: "cursor_sdk",
      }),
    ).toBe(false);
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "general",
        agentEngine: "claude_code_local",
      }),
    ).toBe(false);
  });

  it("builds a Cursor prompt from Stella system and ordered prompt messages", () => {
    const prompt = buildCursorPromptFromMessages({
      systemPrompt: "You are Stella.",
      promptMessages: [
        {
          text: "hidden context",
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.test",
        },
        { text: "Do the work." },
      ],
    });

    expect(prompt).toContain("<stella_system_prompt>\nYou are Stella.");
    expect(prompt).toContain(
      '<message index="1" type="message" visibility="hidden" customType="runtime.test">',
    );
    expect(prompt).toContain('<message index="2" type="user" visibility="visible">');
  });

  it("diffs Cursor-owned worktree changes, including already-dirty files", () => {
    const before = snapshot(" M src/existing.ts\n", {
      "src/existing.ts": "before",
    });
    const after = snapshot(" M src/existing.ts\n?? src/new.ts\n", {
      "src/existing.ts": "after",
      "src/new.ts": "new",
    });

    expect(diffCursorWorktreeSnapshots(before, after)).toEqual([
      {
        path: path.resolve("/repo", "src/existing.ts"),
        kind: { type: "update" },
      },
      {
        path: path.resolve("/repo", "src/new.ts"),
        kind: { type: "add" },
      },
    ]);
  });

  it("snapshots files inside newly-created directories", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-cursor-snap-"));
    try {
      await execFileAsync("git", ["init"], { cwd: repoRoot });
      await mkdir(path.join(repoRoot, "src", "new-dir"), { recursive: true });
      await writeFile(
        path.join(repoRoot, "src", "new-dir", "created.ts"),
        "export const created = true;\n",
        "utf8",
      );

      const tree = await snapshotCursorWorktree(repoRoot);
      expect(tree?.entries.has("src/new-dir/")).toBe(false);
      expect(tree?.entries.get("src/new-dir/created.ts")).toMatchObject({
        path: "src/new-dir/created.ts",
        status: "??",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves rename destinations from git porcelain status", () => {
    const before = snapshot("", {});
    const after = snapshot("R  src/old.ts -> src/new.ts\n", {
      "src/new.ts": "renamed",
    });

    expect(diffCursorWorktreeSnapshots(before, after)).toEqual([
      {
        path: path.resolve("/repo", "src/old.ts"),
        kind: {
          type: "update",
          move_path: path.resolve("/repo", "src/new.ts"),
        },
      },
    ]);
  });
});
