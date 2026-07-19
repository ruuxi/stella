import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { dispatchLocalTool } from "../../../../../runtime/kernel/tools/local-tool-dispatch.js";
import {
  ensureDreamMemoryLayout,
  MEMORY_MAP_MAX_CHARS,
  memoryMapPath,
} from "../../../../../runtime/kernel/memory/dream-storage.js";

const activeRoots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "stella-local-tool-dispatch-"),
  );
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    await rm(rootPath, { recursive: true, force: true });
  }
  activeRoots.clear();
});

describe("dispatchLocalTool", () => {
  it("redacts Dream reads before returning memory files to the model", async () => {
    const rootPath = await createRoot();
    const extensionDir = path.join(rootPath, "memories_extensions", "manual");
    await mkdir(extensionDir, { recursive: true });
    const notePath = path.join(extensionDir, "note.md");
    await writeFile(
      notePath,
      "OPENAI_API_KEY=sk-testsecret12345678901234567890\n",
      "utf-8",
    );

    const result = await dispatchLocalTool(
      TOOL_IDS.READ,
      { file_path: notePath },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const text = result.handled ? result.text : "";
    expect(text).not.toContain("sk-testsecret12345678901234567890");
    expect(text).toContain("OPENAI_API_KEY=");
    expect(text).toContain("***");
  });

  it("redacts Dream StrReplace writes before updating durable memory", async () => {
    const rootPath = await createRoot();
    const memoriesDir = path.join(rootPath, "memories");
    await mkdir(memoriesDir, { recursive: true });
    const memoryPath = path.join(memoriesDir, "MEMORY.md");
    await writeFile(memoryPath, "## Active\nold\n", "utf-8");

    const result = await dispatchLocalTool(
      TOOL_IDS.STR_REPLACE,
      {
        file_path: memoryPath,
        old_string: "old",
        new_string: "OPENAI_API_KEY=sk-testsecret12345678901234567890",
      },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const updated = await readFile(memoryPath, "utf-8");
    expect(updated).not.toContain("sk-testsecret12345678901234567890");
    expect(updated).toContain("OPENAI_API_KEY=");
    expect(updated).toContain("***");
  });

  const strReplace = async (
    rootPath: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await dispatchLocalTool(TOOL_IDS.STR_REPLACE, args, {
      conversationId: "c1",
      dream: { stellaDataDir: rootPath },
    });
    expect(result.handled).toBe(true);
    return JSON.parse(result.handled ? result.text : "{}");
  };

  it("rejects a memory_map write that would exceed the injected hard cap, leaving the file untouched", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);
    const before = await readFile(mapPath, "utf-8");

    const oversized = "- entry pointing somewhere useful\n".repeat(300);
    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: "- No routing entries recorded yet.",
      new_string: oversized,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(`hard cap ${MEMORY_MAP_MAX_CHARS}`);
    expect(outcome.error).toContain("Curate");
    await expect(readFile(mapPath, "utf-8")).resolves.toBe(before);
  });

  it("does not charge HTML comments against the map cap and accepts an in-budget write", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);

    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: "- No routing entries recorded yet.",
      new_string:
        "- muse benchmark -> MEMORY.md 2026-06-27 (updated 2026-07-18) | aliases: minecraft, self-mod",
    });

    expect(outcome.success).toBe(true);
    const updated = await readFile(mapPath, "utf-8");
    expect(updated).toContain("muse benchmark");
    // The charter comment (well over the per-entry weight) is still present
    // and did not count against the accepted write.
    expect(updated).toContain("DREAM:MAP_CHARTER");
  });

  it("rejects a map write that deletes the routing anchors", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);
    const before = await readFile(mapPath, "utf-8");

    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: "<!-- DREAM:MAP_START -->",
      new_string: "",
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("anchors must stay intact");
    await expect(readFile(mapPath, "utf-8")).resolves.toBe(before);
  });

  it("rejects a map write that deletes the derived-constraints anchors", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);
    const before = await readFile(mapPath, "utf-8");

    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: "<!-- DREAM:DERIVED_START -->",
      new_string: "",
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("DERIVED");
    expect(outcome.error).toContain("anchors must stay intact");
    await expect(readFile(mapPath, "utf-8")).resolves.toBe(before);
  });

  it("accepts a write that restores missing derived anchors", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);
    // Simulate a file that lost the derived pair before this guard existed.
    const damaged = (await readFile(mapPath, "utf-8"))
      .replace("<!-- DREAM:DERIVED_START -->\n", "")
      .replace("<!-- DREAM:DERIVED_END -->\n", "");
    await writeFile(mapPath, damaged, "utf-8");

    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: "- None pending promotion.",
      new_string:
        "<!-- DREAM:DERIVED_START -->\n- None pending promotion.\n<!-- DREAM:DERIVED_END -->",
    });

    expect(outcome.success).toBe(true);
    const repaired = await readFile(mapPath, "utf-8");
    expect(repaired).toContain("<!-- DREAM:DERIVED_START -->");
    expect(repaired).toContain("<!-- DREAM:DERIVED_END -->");
  });

  it("rejects a map write that reorders anchors (END before START)", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const mapPath = memoryMapPath(rootPath);
    const before = await readFile(mapPath, "utf-8");

    // Both anchors remain PRESENT but swapped — the old presence-only guard
    // accepted exactly this corruption.
    const swapped = before
      .replace("<!-- DREAM:MAP_START -->", "<!-- TMP_SWAP -->")
      .replace("<!-- DREAM:MAP_END -->", "<!-- DREAM:MAP_START -->")
      .replace("<!-- TMP_SWAP -->", "<!-- DREAM:MAP_END -->");
    const outcome = await strReplace(rootPath, {
      file_path: mapPath,
      old_string: before,
      new_string: swapped,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("in that order");
    await expect(readFile(mapPath, "utf-8")).resolves.toBe(before);
  });

  it("hides delta-covered rows from the Dream list via the exclusion config (delta mode)", async () => {
    const rootPath = await createRoot();
    const listCalls: Array<Record<string, unknown> | undefined> = [];
    const inbox = {
      listUnprocessed: (args?: Record<string, unknown>) => {
        listCalls.push(args);
        return [
          {
            id: 7,
            kind: "chronicle",
            sourceKey: "10m",
            threadId: null,
            runId: null,
            agentType: null,
            title: "Chronicle 10m screen-activity digest",
            content: "digest body",
            metadata: null,
            conversationId: null,
            sourceUpdatedAt: 123,
            processedByDreamAt: null,
            usageCount: 0,
            lastUsage: null,
          },
        ];
      },
    };

    const result = await dispatchLocalTool(
      TOOL_IDS.DREAM,
      { action: "list" },
      {
        conversationId: "dream",
        store: { dreamInboxStore: inbox as never },
        dream: {
          stellaDataDir: rootPath,
          inboxListExclude: {
            conversationId: "conv-b",
            kinds: ["thread_summary", "memory_note"],
          },
        },
      },
    );

    expect(result.handled).toBe(true);
    expect(listCalls).toEqual([
      {
        excludeConversationKinds: {
          conversationId: "conv-b",
          kinds: ["thread_summary", "memory_note"],
        },
      },
    ]);
    const text = result.handled ? result.text : "";
    expect(text).toContain("digest body");
  });

  it("denies Dream reads of the shadow-validation log", async () => {
    const rootPath = await createRoot();
    const memoriesDir = path.join(rootPath, "memories");
    await mkdir(memoriesDir, { recursive: true });
    const shadowPath = path.join(memoriesDir, "memory_shadow.md");
    await writeFile(shadowPath, "unvalidated proposals\n", "utf-8");

    const result = await dispatchLocalTool(
      TOOL_IDS.READ,
      { file_path: shadowPath },
      {
        conversationId: "dream",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const parsed = JSON.parse(result.handled ? result.text : "{}") as {
      success: boolean;
      error?: string;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("shadow-validation log");
    expect(result.handled ? result.text : "").not.toContain(
      "unvalidated proposals",
    );
  });

  it("rejects writes to the retired summary/index files with a pointer to the map", async () => {
    const rootPath = await createRoot();
    const memoriesDir = path.join(rootPath, "memories");
    await mkdir(memoriesDir, { recursive: true });
    for (const retired of ["memory_summary.md", "memory_index.md"]) {
      const retiredPath = path.join(memoriesDir, retired);
      await writeFile(retiredPath, "frozen content\n", "utf-8");
      const outcome = await strReplace(rootPath, {
        file_path: retiredPath,
        old_string: "frozen content",
        new_string: "sneaky edit",
      });
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("retired and read-only");
      expect(outcome.error).toContain("memory_map.md");
      await expect(readFile(retiredPath, "utf-8")).resolves.toBe(
        "frozen content\n",
      );
    }
  });
});
