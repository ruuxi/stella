import { describe, expect, it } from "vitest";
import {
  isUiOnlyAssistantStatus,
  sanitizeAssistantText,
} from "../../../packages/runtime-kernel/internal-tool-transcript.js";

describe("internal-tool-transcript", () => {
  it("keeps assistant prose while removing leaked internal transcript lines", () => {
    const text = [
      "[Assistant thinking] Need to inspect the repo",
      "[Assistant] See you later.",
      "[Assistant tool calls] goodbye()",
    ].join("\n");

    expect(sanitizeAssistantText(text)).toBe("See you later.");
  });

  it("drops tool call and tool result blocks entirely", () => {
    const text = [
      "[Tool call] goodbye",
      "args: {}",
      "",
      "[Tool result] goodbye",
      "content: ok",
    ].join("\n");

    expect(sanitizeAssistantText(text)).toBe("");
  });

  it("detects ui-only assistant status markers", () => {
    expect(isUiOnlyAssistantStatus("[TOOL CALL: goodbye]")).toBe(true);
    expect(isUiOnlyAssistantStatus("[WEB SEARCH] weather -> 3 results")).toBe(
      true,
    );
    expect(isUiOnlyAssistantStatus("[Assistant] Normal reply")).toBe(false);
  });
});
