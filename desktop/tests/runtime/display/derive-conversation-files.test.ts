import { describe, expect, it } from "vitest";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "../../../src/shell/display/derive-conversation-files";
import type { EventRecord } from "../../../src/app/chat/lib/event-transforms";

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
});
