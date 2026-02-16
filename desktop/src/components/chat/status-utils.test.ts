import { describe, expect, it } from "vitest";
import { computeStatus } from "./status-utils";

describe("computeStatus", () => {
  it("returns default message when options are undefined", () => {
    expect(computeStatus()).toBe("Considering next steps");
  });

  it("returns default message when all options are falsy", () => {
    expect(computeStatus({})).toBe("Considering next steps");
  });

  describe("tool name mapping", () => {
    it("maps todowrite to planning", () => {
      expect(computeStatus({ toolName: "todowrite" })).toBe("Planning next steps");
    });

    it("maps todoread to planning", () => {
      expect(computeStatus({ toolName: "todoread" })).toBe("Planning next steps");
    });

    it("maps read to gathering context", () => {
      expect(computeStatus({ toolName: "read" })).toBe("Gathering context");
    });

    it("maps list to searching", () => {
      expect(computeStatus({ toolName: "list" })).toBe("Searching the codebase");
    });

    it("maps grep to searching", () => {
      expect(computeStatus({ toolName: "grep" })).toBe("Searching the codebase");
    });

    it("maps glob to searching", () => {
      expect(computeStatus({ toolName: "glob" })).toBe("Searching the codebase");
    });

    it("maps webfetch to web search", () => {
      expect(computeStatus({ toolName: "webfetch" })).toBe("Searching the web");
    });

    it("maps edit to making edits", () => {
      expect(computeStatus({ toolName: "edit" })).toBe("Making edits");
    });

    it("maps write to making edits", () => {
      expect(computeStatus({ toolName: "write" })).toBe("Making edits");
    });

    it("maps bash to running commands", () => {
      expect(computeStatus({ toolName: "bash" })).toBe("Running commands");
    });

    it("falls through to Using <name> for unknown tools", () => {
      expect(computeStatus({ toolName: "CustomTool" })).toBe("Using CustomTool");
    });

    it("matches case-insensitively", () => {
      expect(computeStatus({ toolName: "READ" })).toBe("Gathering context");
      expect(computeStatus({ toolName: "Bash" })).toBe("Running commands");
      expect(computeStatus({ toolName: "WebFetch" })).toBe("Searching the web");
    });
  });

  describe("activity flags", () => {
    it("returns Thinking when isReasoning is true", () => {
      expect(computeStatus({ isReasoning: true })).toBe("Thinking");
    });

    it("returns Responding when isResponding is true", () => {
      expect(computeStatus({ isResponding: true })).toBe("Responding");
    });

    it("prioritizes toolName over isReasoning", () => {
      expect(computeStatus({ toolName: "read", isReasoning: true })).toBe("Gathering context");
    });

    it("prioritizes isReasoning over isResponding", () => {
      expect(computeStatus({ isReasoning: true, isResponding: true })).toBe("Thinking");
    });

    it("prioritizes toolName over isResponding", () => {
      expect(computeStatus({ toolName: "bash", isResponding: true })).toBe("Running commands");
    });

    it("prioritizes toolName over both isReasoning and isResponding", () => {
      expect(
        computeStatus({ toolName: "edit", isReasoning: true, isResponding: true })
      ).toBe("Making edits");
    });

    it("returns default when isReasoning and isResponding are both false", () => {
      expect(computeStatus({ isReasoning: false, isResponding: false })).toBe(
        "Considering next steps"
      );
    });
  });

  describe("edge cases", () => {
    it("handles empty string toolName by falling through to flags", () => {
      // empty string is falsy, so toolName branch is skipped
      expect(computeStatus({ toolName: "", isReasoning: true })).toBe("Thinking");
    });

    it("handles empty string toolName with no flags", () => {
      expect(computeStatus({ toolName: "" })).toBe("Considering next steps");
    });

    it("preserves original casing in unknown tool names", () => {
      expect(computeStatus({ toolName: "MySpecialTool" })).toBe("Using MySpecialTool");
    });

    it("handles mixed case for all tool groups", () => {
      expect(computeStatus({ toolName: "TodoWrite" })).toBe("Planning next steps");
      expect(computeStatus({ toolName: "TODOREAD" })).toBe("Planning next steps");
      expect(computeStatus({ toolName: "LIST" })).toBe("Searching the codebase");
      expect(computeStatus({ toolName: "Grep" })).toBe("Searching the codebase");
      expect(computeStatus({ toolName: "GLOB" })).toBe("Searching the codebase");
      expect(computeStatus({ toolName: "Edit" })).toBe("Making edits");
      expect(computeStatus({ toolName: "WRITE" })).toBe("Making edits");
    });
  });
});
