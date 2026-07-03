import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatClaudeCodeResolvedModel,
  readClaudeCodeResolvedModels,
  recordClaudeCodeResolvedModel,
} from "../../../../../runtime/kernel/integrations/claude-code-resolved-models.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

describe("claude-code-resolved-models", () => {
  it("round-trips requested -> resolved model mappings", async () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({});

    await recordClaudeCodeResolvedModel(dir, "default", "claude-opus-4-8[1m]");
    await recordClaudeCodeResolvedModel(
      dir,
      "sonnet",
      "claude-sonnet-4-5-20250929",
    );
    expect(readClaudeCodeResolvedModels(dir)).toEqual({
      default: "claude-opus-4-8[1m]",
      sonnet: "claude-sonnet-4-5-20250929",
    });

    // Later resolutions overwrite the previous mapping for the same alias.
    await recordClaudeCodeResolvedModel(dir, "default", "claude-sonnet-5");
    expect(readClaudeCodeResolvedModels(dir).default).toBe("claude-sonnet-5");
  });

  it("serializes concurrent writes without losing updates", async () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    await Promise.all([
      recordClaudeCodeResolvedModel(dir, "default", "claude-opus-4-8"),
      recordClaudeCodeResolvedModel(dir, "sonnet", "claude-sonnet-4-5"),
      recordClaudeCodeResolvedModel(dir, "opus", "claude-opus-4-5"),
      recordClaudeCodeResolvedModel(dir, "haiku", "claude-haiku-4-5"),
    ]);
    expect(readClaudeCodeResolvedModels(dir)).toEqual({
      default: "claude-opus-4-8",
      sonnet: "claude-sonnet-4-5",
      opus: "claude-opus-4-5",
      haiku: "claude-haiku-4-5",
    });
    // Writes land via temp-file + rename; no stray temp files remain.
    expect(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("bounds full-model-id keys to a small LRU while keeping aliases", async () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    await recordClaudeCodeResolvedModel(dir, "default", "claude-opus-4-8");
    for (let index = 0; index < 10; index += 1) {
      await recordClaudeCodeResolvedModel(
        dir,
        `claude-custom-${index}`,
        `claude-custom-${index}-resolved`,
      );
    }
    const stored = readClaudeCodeResolvedModels(dir);
    // The alias mapping survives unbounded full-id churn.
    expect(stored.default).toBe("claude-opus-4-8");
    const nonAliasKeys = Object.keys(stored).filter(
      (key) => key !== "default",
    );
    expect(nonAliasKeys).toHaveLength(8);
    // Newest-first retention: the two oldest full ids were evicted.
    expect(stored["claude-custom-0"]).toBeUndefined();
    expect(stored["claude-custom-1"]).toBeUndefined();
    expect(stored["claude-custom-9"]).toBe("claude-custom-9-resolved");
  });

  it("normalizes an empty requested model to the default alias", async () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    await recordClaudeCodeResolvedModel(dir, "  ", "claude-opus-4-8");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({
      default: "claude-opus-4-8",
    });
  });

  it("ignores empty resolved models and unreadable files", async () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    await recordClaudeCodeResolvedModel(dir, "default", "   ");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({});
    expect(readClaudeCodeResolvedModels("/nonexistent/definitely-not")).toEqual(
      {},
    );
  });

  it("pretty-prints CLI-reported model ids", () => {
    expect(formatClaudeCodeResolvedModel("claude-opus-4-8[1m]")).toBe(
      "Opus 4.8 (1M context)",
    );
    expect(formatClaudeCodeResolvedModel("claude-sonnet-4-5-20250929")).toBe(
      "Sonnet 4.5",
    );
    expect(formatClaudeCodeResolvedModel("claude-fable-5")).toBe("Fable 5");
    expect(formatClaudeCodeResolvedModel("claude-haiku-4-5")).toBe(
      "Haiku 4.5",
    );
    // Unknown shapes pass through untouched.
    expect(formatClaudeCodeResolvedModel("my-gateway/custom")).toBe(
      "my-gateway/custom",
    );
  });
});
