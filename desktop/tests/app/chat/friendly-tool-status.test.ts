import { describe, expect, it } from "vitest";
import { friendlyInlineToolStatus } from "@/app/chat/friendly-tool-status";

const activity = (
  toolName: string,
  state: "started" | "completed",
  exitCode?: number,
) => ({
  toolCallId: "call-1",
  toolName,
  label: toolName,
  state,
  ...(exitCode === undefined ? {} : { exitCode }),
});

describe("friendlyInlineToolStatus", () => {
  it("uses state-aware friendly labels for common tools", () => {
    expect(friendlyInlineToolStatus(activity("exec_command", "started"))).toBe(
      "Running command",
    );
    expect(
      friendlyInlineToolStatus(activity("exec_command", "completed", 0)),
    ).toBe("Ran command");
    expect(friendlyInlineToolStatus(activity("Edit", "completed"))).toBe(
      "Edited files",
    );
    expect(friendlyInlineToolStatus(activity("Read", "started"))).toBe(
      "Reading files",
    );
  });

  it("turns non-zero command exits into a friendly failure", () => {
    expect(
      friendlyInlineToolStatus(activity("exec_command", "completed", 2)),
    ).toBe("Command failed");
  });

  it("humanizes unknown and namespaced tool names", () => {
    expect(
      friendlyInlineToolStatus(activity("custom__make_thing", "started")),
    ).toBe("Make Thing");
  });
});
