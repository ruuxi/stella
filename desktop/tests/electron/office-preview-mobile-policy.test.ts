import { describe, expect, it } from "vitest";
import { filterOfficePreviewSnapshotsForMobile } from "../../electron/ipc/office-preview-handlers.js";
import type { OfficePreviewSnapshot } from "../../../runtime/contracts/office-preview.js";
import type { LocalChatEventRecord } from "../../../runtime/kernel/storage/shared.js";

const snapshot = (
  sessionId: string,
  sourcePath: string,
): OfficePreviewSnapshot => ({
  sessionId,
  title: sourcePath.split("/").pop() ?? sourcePath,
  sourcePath,
  format: "docx",
  startedAt: 1_000,
  updatedAt: 1_100,
  status: "ready",
  html: "<p>Preview</p>",
});

describe("mobile office preview policy", () => {
  it("limits mobile office preview snapshots to recent conversation files", () => {
    const events: LocalChatEventRecord[] = [
      {
        _id: "event-1",
        timestamp: 1_000,
        type: "tool_result",
        payload: {
          fileChanges: [
            { path: "/repo/report.docx", kind: { type: "add" } },
            { path: "/repo/deleted.docx", kind: { type: "delete" } },
          ],
        },
      },
    ];

    expect(
      filterOfficePreviewSnapshotsForMobile(
        [
          snapshot("allowed", "/repo/report.docx"),
          snapshot("artifact", "/repo/existing-deck.pptx"),
          snapshot("deleted", "/repo/deleted.docx"),
          snapshot("unrelated", "/Users/rahul/private.docx"),
        ],
        {
          fileEvents: events,
          artifactPaths: new Set(["/repo/existing-deck.pptx"]),
        },
      ).map((entry) => entry.sessionId),
    ).toEqual(["allowed", "artifact"]);
  });
});
