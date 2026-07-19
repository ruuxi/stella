import { afterEach, describe, expect, it } from "vitest";

import { createThreadSummariesRecordHook } from "../../../../../runtime/extensions/stella-runtime/hooks/thread-summaries-record.hook.js";
import { DreamInboxStore } from "../../../../../runtime/kernel/memory/dream-inbox-store.js";
import type { RuntimeStore } from "../../../../../runtime/kernel/storage/runtime-store.js";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-thread-summaries-hook",
  (db) => new DreamInboxStore(db),
);

afterEach(() => testContexts.cleanup());

const ROOT_CONVERSATION = "conv-root";

/** agent_end payload for a finished GENERAL child. Every subagent payload
 * carries the ROOT conversation id — which is exactly why phase 1 must not
 * stamp from it: at finalize time no terminal report has persisted anywhere
 * yet, and for superseded/adopted/crashed runs it never will. */
const buildAgentEndPayload = (args: { threadKey: string; finalText: string }) => ({
  outcome: "success" as const,
  agentType: "general",
  conversationId: ROOT_CONVERSATION,
  threadKey: args.threadKey,
  runId: `run-${args.threadKey}`,
  finalText: args.finalText,
  isUserTurn: false,
  services: {},
});

describe("thread-summaries-record hook (two-phase stamp, phase 1)", () => {
  it("always records rows unstamped; only persist-time promotion makes them consumable", async () => {
    const { store: inbox } = testContexts.create();
    const hook = createThreadSummariesRecordHook({
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
    });

    await hook.handler(
      buildAgentEndPayload({
        threadKey: "child-thread",
        finalText: "Finished the migration.",
      }) as never,
    );
    const row = inbox.listUnprocessed()[0]!;
    expect(row.conversationId).toBeNull();

    // Crash window / supersession / adoption: no orchestrator persist ever
    // happens → no promotion → mechanically unsweepable forever.
    const sweep = () =>
      inbox.markKindsProcessedThrough({
        conversationId: ROOT_CONVERSATION,
        kinds: ["thread_summary", "memory_note"],
        sinceTs: row.sourceUpdatedAt - 60_000,
        throughTs: row.sourceUpdatedAt + 60_000,
      });
    expect(sweep().updated).toBe(0);

    // A different attempt's terminal report persisting must not stamp this
    // row: promotion is content-matched to the exact attempt.
    inbox.promoteThreadSummaryConversation({
      threadId: "child-thread",
      conversationId: ROOT_CONVERSATION,
      rolloutSummary: "A different attempt's report.",
    });
    expect(inbox.listUnprocessed()[0]?.conversationId).toBeNull();

    // Phase 2 (the orchestrator-persist branch): the matching report
    // persisted → the row becomes consumable.
    const promoted = inbox.promoteThreadSummaryConversation({
      threadId: "child-thread",
      conversationId: ROOT_CONVERSATION,
      rolloutSummary: "Finished the migration.",
    });
    expect(promoted.updated).toBe(1);
    expect(inbox.listUnprocessed()[0]?.conversationId).toBe(ROOT_CONVERSATION);
    expect(sweep().updated).toBe(1);
  });

  it("promotion applies the same redaction transform as recording", async () => {
    const { store: inbox } = testContexts.create();
    const hook = createThreadSummariesRecordHook({
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
    });
    const rawSummary =
      "Rotated the key sk-ant-api03-abcdefghijklmnop1234567890 successfully.";
    await hook.handler(
      buildAgentEndPayload({
        threadKey: "redacted-thread",
        finalText: rawSummary,
      }) as never,
    );
    // The lifecycle event carries the RAW result; the stored row is
    // redacted. Promotion must still match — it redacts before comparing.
    const promoted = inbox.promoteThreadSummaryConversation({
      threadId: "redacted-thread",
      conversationId: ROOT_CONVERSATION,
      rolloutSummary: rawSummary,
    });
    expect(promoted.updated).toBe(1);
  });

  it("self-skips without services", async () => {
    const { store: inbox } = testContexts.create();
    const hook = createThreadSummariesRecordHook({
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
    });
    const payload = buildAgentEndPayload({
      threadKey: "one-shot-thread",
      finalText: "internal call",
    });
    await hook.handler({ ...payload, services: undefined } as never);
    expect(inbox.listUnprocessed()).toHaveLength(0);
  });
});
