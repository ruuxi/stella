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
 * carries the ROOT conversation id — that is exactly why the hook must not
 * trust it for reporting scope. */
const buildAgentEndPayload = (args: {
  threadKey: string;
  dreamReportingConversationId?: string;
}) => ({
  outcome: "success" as const,
  agentType: "general",
  conversationId: ROOT_CONVERSATION,
  threadKey: args.threadKey,
  runId: `run-${args.threadKey}`,
  finalText: `Terminal report from ${args.threadKey}.`,
  isUserTurn: false,
  services: {
    ...(args.dreamReportingConversationId
      ? {
          dreamReportingConversationId: args.dreamReportingConversationId,
        }
      : {}),
  },
});

describe("thread-summaries-record hook (reporting scope)", () => {
  it("manager-owned child rows stay NULL-conversation and survive the root delta's mechanical consumption", async () => {
    const { store: inbox } = testContexts.create();
    const hook = createThreadSummariesRecordHook({
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
    });

    // A Manager-spawned GENERAL child finishes: its terminal report went to
    // the MANAGER's thread, never the orchestrator window, so the spawn
    // site did not stamp a reporting conversation. The payload still
    // carries the root conversation id — the pre-fix hook stamped it.
    await hook.handler(
      buildAgentEndPayload({ threadKey: "manager-child-thread" }) as never,
    );
    // An orchestrator-spawned sibling finishes: ancestry verified, stamped.
    await hook.handler(
      buildAgentEndPayload({
        threadKey: "orchestrator-child-thread",
        dreamReportingConversationId: ROOT_CONVERSATION,
      }) as never,
    );

    const rows = inbox.listUnprocessed();
    expect(rows).toHaveLength(2);
    const managerRow = rows.find(
      (row) => row.threadId === "manager-child-thread",
    )!;
    const orchestratorRow = rows.find(
      (row) => row.threadId === "orchestrator-child-thread",
    )!;
    expect(managerRow.conversationId).toBeNull();
    expect(orchestratorRow.conversationId).toBe(ROOT_CONVERSATION);

    // The root conversation's cutover pass completes with coverage past
    // both rows: only the orchestrator-reported row (whose byte-equivalent
    // report the delta actually contained) may be consumed mechanically.
    const windowEnd = Date.now() + 60_000;
    const { updated } = inbox.markKindsProcessedThrough({
      conversationId: ROOT_CONVERSATION,
      kinds: ["thread_summary", "memory_note"],
      sinceTs: managerRow.sourceUpdatedAt - 60_000,
      throughTs: windowEnd,
    });
    expect(updated).toBe(1);

    // The manager child's row is still queued AND still visible through
    // the delta-mode list exclusion — the model-driven path folds it.
    const visible = inbox.listUnprocessed({
      excludeConversationKinds: {
        conversationId: ROOT_CONVERSATION,
        kinds: ["thread_summary", "memory_note"],
        sinceTs: managerRow.sourceUpdatedAt - 60_000,
      },
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.threadId).toBe("manager-child-thread");
  });

  it("self-skips without services and never stamps from the payload's root conversation id", async () => {
    const { store: inbox } = testContexts.create();
    const hook = createThreadSummariesRecordHook({
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
    });

    // One-shot internal call: services omitted entirely.
    const payload = buildAgentEndPayload({ threadKey: "one-shot-thread" });
    await hook.handler({
      ...payload,
      services: undefined,
    } as never);
    expect(inbox.listUnprocessed()).toHaveLength(0);
  });
});
