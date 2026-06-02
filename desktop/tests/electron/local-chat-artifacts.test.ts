import { describe, expect, it } from "vitest";
import {
  buildMobileSyncMessagesPage,
  buildMobileSyncMessages,
  decodeMobileSyncCursor,
  deriveMobileArtifactsForMessage,
} from "../../electron/services/local-chat-artifacts.js";
import type { MessageRecord } from "../../../runtime/contracts/local-chat.js";

const baseMessage = (overrides: Partial<MessageRecord>): MessageRecord => ({
  _id: "message-1",
  timestamp: 1_000,
  type: "assistant_message",
  payload: { text: "Done" },
  toolEvents: [],
  ...overrides,
});

describe("local chat mobile artifacts", () => {
  it("derives display payloads from file-producing tool events", () => {
    const artifacts = deriveMobileArtifactsForMessage(
      baseMessage({
        toolEvents: [
          {
            _id: "tool-1",
            timestamp: 1_100,
            type: "tool_result",
            payload: {
              toolName: "exec_command",
              producedFiles: [
                { path: "/tmp/report.pdf", kind: { type: "add" } },
                { path: "/tmp/table.csv", kind: { type: "add" } },
                { path: "/tmp/deleted.md", kind: { type: "delete" } },
              ],
            },
          },
        ],
      }),
    );

    expect(artifacts).toMatchObject([
      { kind: "pdf", filePath: "/tmp/report.pdf" },
      {
        kind: "file-artifact",
        filePath: "/tmp/table.csv",
        artifactKind: "delimited-table",
      },
    ]);
  });

  it("omits developer file artifacts unless explicitly enabled", () => {
    const message = baseMessage({
      toolEvents: [
        {
          _id: "tool-1",
          timestamp: 1_100,
          type: "tool_result",
          payload: {
            toolName: "apply_patch",
            fileChanges: [
              { path: "/repo/src/app.tsx", kind: { type: "update" } },
            ],
          },
        },
      ],
    });

    expect(deriveMobileArtifactsForMessage(message)).toEqual([]);
    expect(
      deriveMobileArtifactsForMessage(message, {
        includeDeveloperArtifacts: true,
      }),
    ).toMatchObject([
      {
        kind: "source-diff",
        filePath: "/repo/src/app.tsx",
        title: "app.tsx",
      },
    ]);
  });

  it("keeps artifact-only assistant rows in mobile sync history", () => {
    const messages = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "assistant-1",
          payload: { text: "" },
          toolEvents: [
            {
              _id: "tool-1",
              timestamp: 1_100,
              type: "tool_result",
              payload: {
                toolName: "html",
                filePath: "/Users/me/.stella/outputs/html/report.html",
              },
            },
          ],
        }),
      ],
      20,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      localMessageId: "assistant-1",
      role: "assistant",
      text: "",
      artifacts: [
        {
          kind: "canvas-html",
          filePath: "/Users/me/.stella/outputs/html/report.html",
          title: "Report",
        },
      ],
    });
  });

  it("returns an opaque cursor for the newest source event in a sync page", () => {
    const page = buildMobileSyncMessagesPage(
      [
        baseMessage({
          _id: "assistant-1",
          timestamp: 1_000,
          payload: { text: "First" },
        }),
        baseMessage({
          _id: "assistant-2",
          timestamp: 2_000,
          payload: { text: "Second" },
          toolEvents: [
            {
              _id: "tool-2",
              timestamp: 2_100,
              type: "tool_result",
              payload: {
                toolName: "html",
                filePath: "/Users/me/.stella/outputs/html/second.html",
              },
            },
          ],
        }),
      ],
      20,
    );

    expect(page.messages.map((message) => message.localMessageId)).toEqual([
      "assistant-1",
      "assistant-2",
    ]);
    expect(decodeMobileSyncCursor(page.cursor)).toEqual({
      timestamp: 2_100,
      id: "tool-2",
    });
  });
});
