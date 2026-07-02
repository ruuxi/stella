import { describe, expect, it } from "vitest";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "../../../src/features/workspace-display/derive-conversation-files";
import type { EventRecord } from "../../../src/features/chat/lib/event-transforms";

const event = (
  partial: Partial<EventRecord> &
    Pick<EventRecord, "_id" | "type" | "timestamp">,
): EventRecord => ({
  payload: {},
  ...partial,
});

describe("deriveConversationFiles", () => {
  it("surfaces html tool results as canvas files", () => {
    const files = deriveConversationFiles([
      event({
        _id: "r1",
        type: "tool_result",
        timestamp: 7,
        payload: {
          toolName: "html",
          filePath:
            "/Users/me/projects/stella/outputs/html/stella-agent-tools-flow.html",
          slug: "stella-agent-tools-flow",
          title: "Stella Agent/Tools Flow",
          createdAt: 6,
          fileChanges: [
            {
              path: "/Users/me/projects/stella/outputs/html/stella-agent-tools-flow.html",
              kind: { type: "add" },
            },
          ],
        },
      }),
    ]);

    expect(files).toEqual<ConversationFileEntry[]>([
      {
        path: "/Users/me/projects/stella/outputs/html/stella-agent-tools-flow.html",
        timestamp: 7,
        payload: {
          kind: "canvas-html",
          filePath:
            "/Users/me/projects/stella/outputs/html/stella-agent-tools-flow.html",
          slug: "stella-agent-tools-flow",
          title: "Stella Agent/Tools Flow",
          createdAt: 6,
        },
      },
    ]);
  });

  it("does not treat ordinary html file changes as recent canvas files", () => {
    expect(
      deriveConversationFiles([
        event({
          _id: "r1",
          type: "tool_result",
          timestamp: 7,
          payload: {
            toolName: "apply_patch",
            fileChanges: [
              {
                path: "/Users/me/projects/site/index.html",
                kind: { type: "add" },
              },
            ],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("surfaces html files written anywhere under ~/.stella/outputs/ as canvas files", () => {
    const files = deriveConversationFiles([
      event({
        _id: "r1",
        type: "tool_result",
        timestamp: 8,
        payload: {
          toolName: "exec_command",
          producedFiles: [
            {
              path: "/Users/me/.stella/outputs/recall-blindspot-report.html",
              kind: { type: "add" },
            },
          ],
        },
      }),
    ]);

    expect(files).toEqual<ConversationFileEntry[]>([
      {
        path: "/Users/me/.stella/outputs/recall-blindspot-report.html",
        timestamp: 8,
        payload: {
          kind: "canvas-html",
          filePath: "/Users/me/.stella/outputs/recall-blindspot-report.html",
          slug: "recall-blindspot-report",
          title: "Recall Blindspot Report",
          createdAt: 8,
        },
      },
    ]);
  });

  it("drops profile/log noise from producedFiles but keeps explicit fileChanges", () => {
    const files = deriveConversationFiles([
      event({
        _id: "r1",
        type: "tool_result",
        timestamp: 9,
        payload: {
          toolName: "exec_command",
          fileChanges: [
            {
              path: "/Users/me/.stella/outputs/demos/notes.md",
              kind: { type: "update" },
            },
          ],
          producedFiles: [
            {
              path: "/Users/me/stella/.stella-launch.log",
              kind: { type: "update" },
            },
            {
              path: "/Users/me/.stella/outputs/demos/.brave-profile/Local State",
              kind: { type: "update" },
            },
            {
              path: "/Users/me/.stella/outputs/demos/demo1.mp4",
              kind: { type: "update" },
            },
          ],
        },
      }),
    ]);

    expect(files.map((entry) => entry.path)).toEqual([
      "/Users/me/.stella/outputs/demos/notes.md",
      "/Users/me/.stella/outputs/demos/demo1.mp4",
    ]);
  });
});
