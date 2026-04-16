import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_TOOL_ALLOWLIST,
  isAllowedGoogleWorkspaceTool,
  toGoogleWorkspaceToolRegistrationName,
} from "../../../../../runtime/kernel/google-workspace/tool-allowlist.js";

describe("google-workspace-allowlist", () => {
  it("allows curated tools", () => {
    expect(isAllowedGoogleWorkspaceTool("gmail.search")).toBe(true);
    expect(isAllowedGoogleWorkspaceTool("calendar.listEvents")).toBe(true);
    expect(isAllowedGoogleWorkspaceTool("people_getMe")).toBe(true);
    expect(isAllowedGoogleWorkspaceTool("auth_clear")).toBe(true);
  });

  it("blocks tools outside the curated set", () => {
    expect(isAllowedGoogleWorkspaceTool("chat.sendMessage")).toBe(false);
    expect(isAllowedGoogleWorkspaceTool("calendar.deleteEvent")).toBe(false);
    expect(isAllowedGoogleWorkspaceTool("drive.trashFile")).toBe(false);
  });

  it("has a stable non-empty list", () => {
    expect(GOOGLE_WORKSPACE_TOOL_ALLOWLIST.length).toBeGreaterThan(10);
  });

  it("creates provider-safe registration names", () => {
    expect(toGoogleWorkspaceToolRegistrationName("gmail.search")).toBe(
      "gmail_search",
    );
    expect(
      toGoogleWorkspaceToolRegistrationName("time.getCurrentDate"),
    ).toBe("time_getCurrentDate");
    expect(toGoogleWorkspaceToolRegistrationName("people_getMe")).toBe(
      "people_getMe",
    );
  });
});
