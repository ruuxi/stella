import { describe, expect, it } from "vitest";
import { formatGoogleWorkspaceCallToolResult } from "../../../../packages/runtime-kernel/google-workspace/format-google-workspace-result.js";

describe("google-workspace-mcp", () => {
  it("treats JSON error text payloads as tool errors", () => {
    expect(
      formatGoogleWorkspaceCallToolResult({
        content: [
          {
            type: "text",
            text: '{"error":"Authentication required. Please sign in."}',
          },
        ],
      }),
    ).toEqual({
      error: "Authentication required. Please sign in.",
    });
  });

  it("preserves successful text results", () => {
    expect(
      formatGoogleWorkspaceCallToolResult({
        content: [{ type: "text", text: '{"names":[{"displayName":"Ada"}]}' }],
      }),
    ).toEqual({
      result: '{"names":[{"displayName":"Ada"}]}',
    });
  });
});
