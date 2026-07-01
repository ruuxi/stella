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

  it("lifts map-route artifacts from successful map tool results", () => {
    const map = {
      kind: "map-route",
      version: 1,
      markers: [
        { id: "p1", name: "Blue Bottle Coffee", lat: 37.7961, lng: -122.3939 },
      ],
    };
    const artifacts = deriveMobileArtifactsForMessage(
      baseMessage({
        toolEvents: [
          {
            _id: "tool-1",
            timestamp: 1_100,
            type: "tool_result",
            payload: { toolName: "map", map },
          },
          {
            // Duplicate payload on the same turn dedupes to one card.
            _id: "tool-2",
            timestamp: 1_200,
            type: "tool_result",
            payload: { toolName: "map", map },
          },
          {
            // Errored map calls never become cards.
            _id: "tool-3",
            timestamp: 1_300,
            type: "tool_result",
            payload: { toolName: "map", error: "Map lookup failed", map },
          },
        ],
      }),
    );
    expect(artifacts).toEqual([map]);
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

  it("derives a running agent-work card from an agent-started event", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now,
          payload: { text: "On it" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      localMessageId: "a1",
      role: "assistant",
      text: "On it",
      artifacts: [
        {
          id: "agent-work:t1",
          payload: {
            kind: "agent-work",
            state: "running",
            total: 1,
            completed: 0,
            title: "Book flights",
            subtitle: "Working in background",
          },
        },
      ],
    });
  });

  it("settles the agent-work card once the thread completes", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now,
          payload: { text: "On it" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now - 2_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
            {
              _id: "ac1",
              timestamp: now - 1_000,
              type: "agent-completed",
              payload: { agentId: "t1" },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows[0]?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1",
      payload: {
        kind: "agent-work",
        state: "done",
        total: 1,
        completed: 1,
        title: "Book flights",
        subtitle: "Finished",
      },
    });
  });

  it("tallies multiple agents started in one turn", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now,
          payload: { text: "" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
            {
              _id: "as2",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t2", description: "Find hotels" },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows[0]?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1,t2",
      payload: {
        kind: "agent-work",
        state: "running",
        total: 2,
        completed: 0,
        title: "Working on 2 tasks",
        subtitle: "0 of 2 done",
      },
    });
  });

  it("bridges generated reasoning summaries onto the running task", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now,
          payload: { text: "Working" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
      ],
      20,
      undefined,
      new Map([["t1", ["reading flight options", "comparing fares"]]]),
    );

    const task = rows.find((row) => row.localMessageId === "a1")?.tasks?.[0];
    expect(task).toMatchObject({ id: "t1", status: "running" });
    // Ordered oldest -> newest, exactly the phrases the desktop tray shows.
    expect(task?.reasoningSummaries).toEqual([
      "reading flight options",
      "comparing fares",
    ]);
  });

  it("omits reasoningSummaries when no summaries are bridged", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now,
          payload: { text: "Working" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
      ],
      20,
    );

    const task = rows.find((row) => row.localMessageId === "a1")?.tasks?.[0];
    expect(task).toMatchObject({ id: "t1", status: "running" });
    expect(task?.reasoningSummaries).toBeUndefined();
  });

  it("scopes completion to each run so a reactivation card stays running", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "a1",
          timestamp: now - 3_000,
          payload: { text: "Starting" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now - 3_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
        baseMessage({
          _id: "a2",
          timestamp: now - 2_000,
          payload: { text: "Done first pass" },
          toolEvents: [
            {
              _id: "ac1",
              timestamp: now - 2_000,
              type: "agent-completed",
              payload: { agentId: "t1" },
            },
          ],
        }),
        baseMessage({
          _id: "a3",
          timestamp: now - 1_000,
          payload: { text: "Revising" },
          toolEvents: [
            {
              _id: "as2",
              timestamp: now - 1_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
      ],
      20,
    );

    const a1 = rows.find((row) => row.localMessageId === "a1");
    const a3 = rows.find((row) => row.localMessageId === "a3");
    // The original card saw a completion at/after its spawn → done. The
    // reactivation card's only completion predates its spawn → still running.
    expect(a1?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1",
      payload: {
        kind: "agent-work",
        state: "done",
      },
    });
    expect(a3?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1",
      payload: {
        kind: "agent-work",
        state: "running",
      },
    });
  });

  it("emits task updates from terminal-only sync rows using full task context", () => {
    const now = Date.now();
    const started = baseMessage({
      _id: "a1",
      timestamp: now - 10_000,
      payload: { text: "Starting background work" },
      toolEvents: [
        {
          _id: "as1",
          timestamp: now - 10_000,
          type: "agent-started",
          payload: { agentId: "t1", description: "Book flights" },
        },
      ],
    });
    const finished = baseMessage({
      _id: "a2",
      timestamp: now,
      payload: { text: "" },
      toolEvents: [
        {
          _id: "af1",
          timestamp: now,
          type: "agent-failed",
          payload: { agentId: "t1", error: "Provider timed out" },
        },
      ],
    });

    const page = buildMobileSyncMessagesPage(
      [finished],
      20,
      [finished],
      undefined,
      undefined,
      [started, finished],
    );

    expect(page.messages.map((message) => message.localMessageId)).toContain(
      "a1",
    );
    const task = page.messages.find(
      (message) => message.localMessageId === "a1",
    )?.tasks?.[0];
    expect(task).toMatchObject({
      id: "t1",
      title: "Book flights",
      status: "error",
    });
  });

  it("emits a fire-and-forget agent card as its own assistant row", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "u1",
          type: "user_message",
          timestamp: now,
          payload: { text: "Book me a flight" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows.map((row) => row.localMessageId)).toEqual(["u1", "u1:agent"]);
    expect(rows[0]).toMatchObject({ role: "user", text: "Book me a flight" });
    expect(rows[1]).toMatchObject({
      role: "assistant",
      artifacts: [
        {
          id: "agent-work:t1",
          payload: {
            kind: "agent-work",
            state: "running",
            title: "Book flights",
          },
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
