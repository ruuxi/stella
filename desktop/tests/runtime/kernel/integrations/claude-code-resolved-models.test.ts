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
  it("round-trips requested -> resolved model mappings", () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({});

    recordClaudeCodeResolvedModel(dir, "default", "claude-opus-4-8[1m]");
    recordClaudeCodeResolvedModel(dir, "sonnet", "claude-sonnet-4-5-20250929");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({
      default: "claude-opus-4-8[1m]",
      sonnet: "claude-sonnet-4-5-20250929",
    });

    // Later resolutions overwrite the previous mapping for the same alias.
    recordClaudeCodeResolvedModel(dir, "default", "claude-sonnet-5");
    expect(readClaudeCodeResolvedModels(dir).default).toBe("claude-sonnet-5");
  });

  it("normalizes an empty requested model to the default alias", () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    recordClaudeCodeResolvedModel(dir, "  ", "claude-opus-4-8");
    expect(readClaudeCodeResolvedModels(dir)).toEqual({
      default: "claude-opus-4-8",
    });
  });

  it("ignores empty resolved models and unreadable files", () => {
    const dir = tempDirs.create("stella-claude-resolved-");
    recordClaudeCodeResolvedModel(dir, "default", "   ");
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
