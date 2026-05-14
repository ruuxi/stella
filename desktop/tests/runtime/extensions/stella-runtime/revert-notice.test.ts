import { describe, expect, it, vi } from "vitest";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { createRevertNoticeHook } from "../../../../../runtime/extensions/stella-runtime/hooks/revert-notice.hook.js";
import type { ExtensionServices } from "../../../../../runtime/kernel/extensions/services.js";
import type { SelfModRevertRecord } from "../../../../../runtime/kernel/storage/self-mod-reverts.js";

type StoreStub = {
  listPendingOrchestratorReverts: ReturnType<typeof vi.fn>;
  listPendingOriginThreadReverts: ReturnType<typeof vi.fn>;
  markSelfModRevertsOrchestratorConsumed: ReturnType<typeof vi.fn>;
  markSelfModRevertsOriginThreadConsumed: ReturnType<typeof vi.fn>;
};

const createServicesStub = (args: {
  orchestratorPending?: SelfModRevertRecord[];
  originThreadPending?: SelfModRevertRecord[];
}) => {
  const store: StoreStub = {
    listPendingOrchestratorReverts: vi.fn(
      () => args.orchestratorPending ?? [],
    ),
    listPendingOriginThreadReverts: vi.fn(
      () => args.originThreadPending ?? [],
    ),
    markSelfModRevertsOrchestratorConsumed: vi.fn(),
    markSelfModRevertsOriginThreadConsumed: vi.fn(),
  };
  return {
    services: { store } as unknown as Pick<ExtensionServices, "store">,
    store,
  };
};

const makeRecord = (overrides?: Partial<SelfModRevertRecord>): SelfModRevertRecord => ({
  revertId: "revert-1",
  conversationId: "conv-1",
  originThreadKey: "thread-x",
  featureId: "abc1234",
  files: ["desktop/src/foo.tsx", "desktop/src/bar.tsx"],
  revertedAt: 1_000,
  consumedByOrchestrator: false,
  consumedByOriginThread: false,
  ...overrides,
});

const orchestratorPayload = {
  agentType: AGENT_IDS.ORCHESTRATOR,
  conversationId: "conv-1",
  threadKey: "conv-1",
  userPrompt: "hi",
  isUserTurn: true,
};

const subagentPayload = {
  agentType: "general",
  conversationId: "conv-1",
  threadKey: "thread-x",
  userPrompt: "do the thing",
  isUserTurn: true,
};

describe("createRevertNoticeHook — gating", () => {
  it("skips entirely on non-user (hidden synthetic) turns", async () => {
    const { services, store } = createServicesStub({
      orchestratorPending: [makeRecord()],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler({
      ...orchestratorPayload,
      isUserTurn: false,
    });

    expect(result).toBeUndefined();
    expect(store.listPendingOrchestratorReverts).not.toHaveBeenCalled();
    expect(store.markSelfModRevertsOrchestratorConsumed).not.toHaveBeenCalled();
  });

  it("skips when orchestrator turn lacks a conversationId", async () => {
    const { services, store } = createServicesStub({
      orchestratorPending: [makeRecord()],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler({
      ...orchestratorPayload,
      conversationId: undefined,
    });

    expect(result).toBeUndefined();
    expect(store.listPendingOrchestratorReverts).not.toHaveBeenCalled();
  });

  it("skips when subagent turn lacks a threadKey", async () => {
    const { services, store } = createServicesStub({
      originThreadPending: [makeRecord()],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler({
      ...subagentPayload,
      threadKey: undefined,
    });

    expect(result).toBeUndefined();
    expect(store.listPendingOriginThreadReverts).not.toHaveBeenCalled();
  });
});

describe("createRevertNoticeHook — orchestrator path", () => {
  it("no-ops when nothing is pending", async () => {
    const { services, store } = createServicesStub({});
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler(orchestratorPayload);

    expect(result).toBeUndefined();
    expect(store.listPendingOrchestratorReverts).toHaveBeenCalledWith("conv-1");
    expect(store.markSelfModRevertsOrchestratorConsumed).not.toHaveBeenCalled();
  });

  it("prepends a hidden system reminder and consumes the orchestrator slot only", async () => {
    const record = makeRecord();
    const { services, store } = createServicesStub({
      orchestratorPending: [record],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler(orchestratorPayload);

    expect(result?.prependMessages).toHaveLength(1);
    const message = result?.prependMessages?.[0];
    expect(message?.uiVisibility).toBe("hidden");
    expect(message?.text).toContain("<system-reminder>");
    expect(message?.text).toContain("undid your last change");
    expect(message?.text).toContain("desktop/src/foo.tsx, desktop/src/bar.tsx");
    expect(store.markSelfModRevertsOrchestratorConsumed).toHaveBeenCalledWith([
      record.revertId,
    ]);
    expect(store.markSelfModRevertsOriginThreadConsumed).not.toHaveBeenCalled();
  });

  it("collapses multiple pending reverts into a single batched reminder", async () => {
    const { services, store } = createServicesStub({
      orchestratorPending: [
        makeRecord({ revertId: "a", files: ["a.ts"] }),
        makeRecord({ revertId: "b", files: ["b.ts"] }),
      ],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler(orchestratorPayload);

    expect(result?.prependMessages).toHaveLength(1);
    expect(result?.prependMessages?.[0]?.text).toContain(
      "undid your last 2 changes",
    );
    expect(store.markSelfModRevertsOrchestratorConsumed).toHaveBeenCalledWith([
      "a",
      "b",
    ]);
  });
});

describe("createRevertNoticeHook — subagent/origin-thread path", () => {
  it("injects reminder when subagent threadKey matches an origin thread", async () => {
    const record = makeRecord();
    const { services, store } = createServicesStub({
      originThreadPending: [record],
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler(subagentPayload);

    expect(result?.prependMessages).toHaveLength(1);
    expect(store.listPendingOriginThreadReverts).toHaveBeenCalledWith(
      "thread-x",
    );
    expect(store.markSelfModRevertsOriginThreadConsumed).toHaveBeenCalledWith([
      record.revertId,
    ]);
    // Did NOT touch the orchestrator slot.
    expect(store.markSelfModRevertsOrchestratorConsumed).not.toHaveBeenCalled();
  });

  it("skips silently when subagent threadKey has no matching origin-thread reverts", async () => {
    const { services, store } = createServicesStub({
      // Empty origin-thread pending — different subagent thread.
    });
    const hook = createRevertNoticeHook(services);

    const result = await hook.handler({
      ...subagentPayload,
      threadKey: "thread-fresh-spawn",
    });

    expect(result).toBeUndefined();
    expect(store.markSelfModRevertsOriginThreadConsumed).not.toHaveBeenCalled();
  });
});

describe("createRevertNoticeHook — failure handling", () => {
  it("treats a ledger-read failure as no-op rather than blocking the turn", async () => {
    const store: StoreStub = {
      listPendingOrchestratorReverts: vi.fn(() => {
        throw new Error("db down");
      }),
      listPendingOriginThreadReverts: vi.fn(() => []),
      markSelfModRevertsOrchestratorConsumed: vi.fn(),
      markSelfModRevertsOriginThreadConsumed: vi.fn(),
    };
    const hook = createRevertNoticeHook({ store } as unknown as Pick<
      ExtensionServices,
      "store"
    >);

    const result = await hook.handler(orchestratorPayload);

    expect(result).toBeUndefined();
    expect(store.markSelfModRevertsOrchestratorConsumed).not.toHaveBeenCalled();
  });
});
