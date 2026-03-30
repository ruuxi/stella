import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST,
  isAllowedGoogleWorkspaceMcpTool,
} from "../../../../packages/runtime-kernel/mcp/google-workspace-allowlist.js";

describe("google-workspace-allowlist", () => {
  it("allows curated tools", () => {
    expect(isAllowedGoogleWorkspaceMcpTool("gmail.search")).toBe(true);
    expect(isAllowedGoogleWorkspaceMcpTool("calendar.listEvents")).toBe(true);
    expect(isAllowedGoogleWorkspaceMcpTool("people_getMe")).toBe(true);
    expect(isAllowedGoogleWorkspaceMcpTool("auth_clear")).toBe(true);
  });

  it("blocks tools outside the curated set", () => {
    expect(isAllowedGoogleWorkspaceMcpTool("chat.sendMessage")).toBe(false);
    expect(isAllowedGoogleWorkspaceMcpTool("calendar.deleteEvent")).toBe(false);
    expect(isAllowedGoogleWorkspaceMcpTool("drive.trashFile")).toBe(false);
  });

  it("has a stable non-empty list", () => {
    expect(GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST.length).toBeGreaterThan(10);
  });
});
