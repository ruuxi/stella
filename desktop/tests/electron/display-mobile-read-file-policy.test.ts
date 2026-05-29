import { describe, expect, it } from "vitest";
import { isDisplayReadPathInLocalChatFiles } from "../../electron/ipc/display-handlers.js";
import type { LocalChatEventRecord } from "../../../runtime/kernel/storage/shared.js";

describe("mobile display read file policy", () => {
  it("allows paths recorded in recent local chat file events", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "tool_result",
        payload: {
          toolName: "apply_patch",
          fileChanges: [
            { path: "/repo/src/original.ts", kind: { type: "update" } },
            {
              path: "/repo/src/old.ts",
              kind: { type: "update", move_path: "/repo/src/moved.ts" },
            },
          ],
        },
      },
      {
        _id: "event-2",
        timestamp: 2_000,
        type: "agent-completed",
        payload: {
          producedFiles: [
            { path: "/repo/out/report.pdf", kind: { type: "add" } },
          ],
        },
      },
    ];

    expect(
      isDisplayReadPathInLocalChatFiles(events, "/repo/src/original.ts"),
    ).toBe(true);
    expect(isDisplayReadPathInLocalChatFiles(events, "/repo/src/moved.ts")).toBe(
      true,
    );
    expect(
      isDisplayReadPathInLocalChatFiles(events, "/repo/out/report.pdf"),
    ).toBe(true);
  });

  it("rejects unrecorded and deleted paths", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "tool_result",
        payload: {
          fileChanges: [
            { path: "/repo/src/deleted.ts", kind: { type: "delete" } },
          ],
        },
      },
    ];

    expect(isDisplayReadPathInLocalChatFiles(events, "/repo/src/deleted.ts")).toBe(
      false,
    );
    expect(isDisplayReadPathInLocalChatFiles(events, "/Users/rahul/.ssh/id_rsa"))
      .toBe(false);
  });
});
