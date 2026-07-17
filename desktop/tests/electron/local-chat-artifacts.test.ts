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
      // The first spawned agent is the aggregate card's stable insertion id;
      // adding t2 updates the visible card instead of replacing/remounting it.
      id: "agent-work:t1",
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

  it("keeps card identity and insertion time across sibling starts and completion", () => {
    const firstStart = {
      _id: "as1",
      timestamp: 1_100,
      type: "agent-started",
      payload: { agentId: "t1", description: "Book flights" },
    };
    const secondStart = {
      _id: "as2",
      timestamp: 1_200,
      type: "agent-started",
      payload: { agentId: "t2", description: "Find hotels" },
    };
    const project = (toolEvents: MessageRecord["toolEvents"]) =>
      buildMobileSyncMessages(
        [
          baseMessage({
            _id: "a1",
            timestamp: 1_000,
            payload: { text: "On it" },
            toolEvents,
          }),
          baseMessage({
            _id: "u2",
            type: "user_message",
            timestamp: 2_000,
            payload: { text: "Next message" },
          }),
        ],
        20,
      );

    const first = project([firstStart]);
    const expanded = project([firstStart, secondStart]);
    const completed = project([
      firstStart,
      secondStart,
      {
        _id: "ac1",
        timestamp: 1_300,
        type: "agent-completed",
        payload: { agentId: "t1" },
      },
      {
        _id: "ac2",
        timestamp: 1_400,
        type: "agent-completed",
        payload: { agentId: "t2" },
      },
    ]);

    expect(first.map((row) => row.localMessageId)).toEqual(["a1", "u2"]);
    expect(expanded.map((row) => row.localMessageId)).toEqual(["a1", "u2"]);
    expect(completed.map((row) => row.localMessageId)).toEqual(["a1", "u2"]);
    for (const rows of [first, expanded, completed]) {
      expect(rows[0]?.artifacts?.[0]).toMatchObject({
        id: "agent-work:t1",
        payload: { agentIds: expect.any(Array), createdAt: 1_100 },
      });
    }
    expect(completed[0]?.artifacts?.[0]).toMatchObject({
      payload: { state: "done", completed: 2, total: 2 },
    });
  });

  it("bridges agent-authored assistant messages onto the running task", () => {
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
    // Ordered oldest -> newest, exactly the agent-authored text supplied.
    expect(task?.assistantMessages).toEqual([
      "reading flight options",
      "comparing fares",
    ]);
    expect(task?.reasoningSummaries).toEqual([
      "reading flight options",
      "comparing fares",
    ]);
  });

  it("clears both current and legacy fields when no authored updates are bridged", () => {
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
    expect(task?.assistantMessages).toEqual([]);
    expect(task?.reasoningSummaries).toEqual([]);
  });

  it("bridges live decoration statusText onto the running task", () => {
    // `agent-progress` rows are no longer persisted, so a running task's
    // current statusText only exists in the renderer's decoration snapshot —
    // the serializer must prefer it over the folded spawn statusText.
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
              payload: {
                agentId: "t1",
                description: "Book flights",
                statusText: "Starting up",
              },
            },
          ],
        }),
      ],
      20,
      undefined,
      undefined,
      undefined,
      new Map([["t1", "Comparing fares on the second site"]]),
    );

    const task = rows.find((row) => row.localMessageId === "a1")?.tasks?.[0];
    expect(task).toMatchObject({
      id: "t1",
      status: "running",
      statusText: "Comparing fares on the second site",
    });
  });

  it("keeps the folded spawn statusText when no decoration is bridged", () => {
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
              payload: {
                agentId: "t1",
                description: "Book flights",
                statusText: "Starting up",
              },
            },
          ],
        }),
      ],
      20,
    );

    const task = rows.find((row) => row.localMessageId === "a1")?.tasks?.[0];
    expect(task).toMatchObject({
      id: "t1",
      status: "running",
      statusText: "Starting up",
    });
  });

  it("never decorates a terminal task with statusText", () => {
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
            {
              _id: "ac1",
              timestamp: now + 100,
              type: "agent-completed",
              payload: { agentId: "t1" },
            },
          ],
        }),
      ],
      20,
      undefined,
      undefined,
      undefined,
      new Map([["t1", "Stale tick from before the terminal"]]),
    );

    const task = rows.find((row) => row.localMessageId === "a1")?.tasks?.[0];
    expect(task).toMatchObject({ id: "t1", status: "completed" });
    expect(task?.statusText).toBeUndefined();
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
    const anchor = page.messages.find(
      (message) => message.localMessageId === "a1",
    );
    const task = anchor?.tasks?.[0];
    expect(task).toMatchObject({
      id: "t1",
      title: "Book flights",
      status: "error",
    });
    // Delta catch-up replays the original anchor row, but the card keeps the
    // same id and first-start timestamp used by the earlier running snapshot.
    expect(anchor?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1",
      payload: { state: "done", createdAt: now - 10_000 },
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

  it("excludes delegated mid-run tool_result files from loose artifacts", () => {
    const artifacts = deriveMobileArtifactsForMessage(
      baseMessage({
        toolEvents: [
          {
            _id: "tool-1",
            timestamp: 1_100,
            type: "tool_result",
            payload: {
              toolName: "exec_command",
              agentType: "general",
              producedFiles: [
                { path: "/tmp/delegated.pdf", kind: { type: "add" } },
              ],
            },
          },
          {
            _id: "tool-2",
            timestamp: 1_200,
            type: "tool_result",
            payload: {
              toolName: "exec_command",
              agentType: "orchestrator",
              producedFiles: [
                { path: "/tmp/direct.pdf", kind: { type: "add" } },
              ],
            },
          },
          {
            // Legacy events predate the agentType stamp and were always
            // orchestrator-direct — they keep rendering inline.
            _id: "tool-3",
            timestamp: 1_300,
            type: "tool_result",
            payload: {
              toolName: "exec_command",
              producedFiles: [
                { path: "/tmp/legacy.pdf", kind: { type: "add" } },
              ],
            },
          },
        ],
      }),
    );

    expect(artifacts).toMatchObject([
      { kind: "pdf", filePath: "/tmp/direct.pdf" },
      { kind: "pdf", filePath: "/tmp/legacy.pdf" },
    ]);
  });

  it("filters noise producedFiles from loose artifacts", () => {
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
                {
                  path: "/Users/me/.brave-profile/state.pdf",
                  kind: { type: "add" },
                },
                { path: "/tmp/report.pdf", kind: { type: "add" } },
              ],
            },
          },
        ],
      }),
    );

    expect(artifacts).toMatchObject([
      { kind: "pdf", filePath: "/tmp/report.pdf" },
    ]);
  });

  it("surfaces html written anywhere under the outputs tree as canvas", () => {
    const artifacts = deriveMobileArtifactsForMessage(
      baseMessage({
        toolEvents: [
          {
            _id: "tool-1",
            timestamp: 1_100,
            type: "tool_result",
            payload: {
              toolName: "exec_command",
              fileChanges: [
                {
                  path: "/Users/me/.stella/outputs/recall-report.html",
                  kind: { type: "add" },
                },
                // Outside the outputs tree stays a developer resource
                // (omitted unless developer artifacts are enabled).
                { path: "/Users/me/site/index.html", kind: { type: "add" } },
              ],
            },
          },
        ],
      }),
    );

    expect(artifacts).toMatchObject([
      {
        kind: "canvas-html",
        filePath: "/Users/me/.stella/outputs/recall-report.html",
        slug: "recall-report",
      },
    ]);
  });

  it("consolidates agent-completed files onto the card's per-agent sections", () => {
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
              timestamp: now - 3_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Write the report" },
            },
            {
              _id: "ac1",
              timestamp: now - 1_000,
              type: "agent-completed",
              payload: {
                agentId: "t1",
                fileChanges: [
                  { path: "/Users/me/work/scratch.md", kind: { type: "add" } },
                ],
                producedFiles: [
                  {
                    path: "/Users/me/.stella/outputs/report.pdf",
                    kind: { type: "add" },
                  },
                  {
                    // Snapshot noise never reaches the section.
                    path: "/Users/me/.brave-profile/cache.pdf",
                    kind: { type: "add" },
                  },
                ],
              },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows).toHaveLength(1);
    const artifacts = rows[0]?.artifacts ?? [];
    // The rollup's files never appear loose — only inside the card.
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: "agent-work:t1",
      payload: {
        kind: "agent-work",
        state: "done",
        agents: [
          {
            agentId: "t1",
            title: "Write the report",
            files: [
              // Declared deliverables lead the section.
              {
                kind: "pdf",
                filePath: "/Users/me/.stella/outputs/report.pdf",
              },
              { kind: "markdown", filePath: "/Users/me/work/scratch.md" },
            ],
          },
        ],
      },
    });
  });

  it("attributes files per agent when several complete in one turn", () => {
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
              timestamp: now - 4_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Draft the memo" },
            },
            {
              _id: "as2",
              timestamp: now - 3_900,
              type: "agent-started",
              payload: { agentId: "t2", description: "Crunch the numbers" },
            },
            {
              _id: "ac1",
              timestamp: now - 2_000,
              type: "agent-completed",
              payload: {
                agentId: "t1",
                fileChanges: [
                  { path: "/Users/me/memo.md", kind: { type: "add" } },
                ],
              },
            },
            {
              _id: "ac2",
              timestamp: now - 1_000,
              type: "agent-completed",
              payload: {
                agentId: "t2",
                fileChanges: [
                  { path: "/Users/me/numbers.csv", kind: { type: "add" } },
                ],
              },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows[0]?.artifacts?.[0]).toMatchObject({
      payload: {
        kind: "agent-work",
        state: "done",
        total: 2,
        completed: 2,
        agents: [
          {
            agentId: "t1",
            title: "Draft the memo",
            files: [{ kind: "markdown", filePath: "/Users/me/memo.md" }],
          },
          {
            agentId: "t2",
            title: "Crunch the numbers",
            files: [
              {
                kind: "file-artifact",
                filePath: "/Users/me/numbers.csv",
                artifactKind: "delimited-table",
              },
            ],
          },
        ],
      },
    });
  });

  it("files a fire-and-forget completion onto the spawning row's card", () => {
    const now = Date.now();
    const rows = buildMobileSyncMessages(
      [
        baseMessage({
          _id: "u1",
          type: "user_message",
          timestamp: now - 5_000,
          payload: { text: "Book me a flight" },
          toolEvents: [
            {
              _id: "as1",
              timestamp: now - 5_000,
              type: "agent-started",
              payload: { agentId: "t1", description: "Book flights" },
            },
          ],
        }),
        baseMessage({
          _id: "a2",
          timestamp: now - 1_000,
          payload: { text: "All booked." },
          toolEvents: [
            {
              _id: "ac1",
              timestamp: now - 1_000,
              type: "agent-completed",
              payload: {
                agentId: "t1",
                producedFiles: [
                  {
                    path: "/Users/me/.stella/outputs/itinerary.pdf",
                    kind: { type: "add" },
                  },
                ],
              },
            },
          ],
        }),
      ],
      20,
    );

    expect(rows.map((row) => row.localMessageId)).toEqual([
      "u1",
      "u1:agent",
      "a2",
    ]);
    // The completion row itself ships no loose copy of the rollup files.
    expect(rows[2]?.artifacts).toBeUndefined();
    expect(rows[1]?.artifacts?.[0]).toMatchObject({
      id: "agent-work:t1",
      payload: {
        kind: "agent-work",
        state: "done",
        agents: [
          {
            agentId: "t1",
            files: [
              {
                kind: "pdf",
                filePath: "/Users/me/.stella/outputs/itinerary.pdf",
              },
            ],
          },
        ],
      },
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
