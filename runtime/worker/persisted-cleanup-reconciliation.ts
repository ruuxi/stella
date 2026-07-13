import { AGENT_PENDING_CLEANUP_EXPIRY_MS } from "../kernel/agents/cleanup-policy.js";
import type { SelfModHmrController } from "../kernel/self-mod/hmr.js";
import type { RuntimeStore } from "../kernel/storage/runtime-store.js";

type CleanupRuntimeStore = Pick<
  RuntimeStore,
  | "reconcilePendingAgentCleanupRecords"
  | "getNextPendingAgentCleanupExpiryAt"
>;

const notifyReconciledConversations = (
  reconciled: {
    clearedConversationIds: string[];
    expiredConversationIds: string[];
  },
  notify: (conversationId: string) => void,
): void => {
  for (const conversationId of new Set([
    ...reconciled.clearedConversationIds,
    ...reconciled.expiredConversationIds,
  ])) {
    notify(conversationId);
  }
};

export const expireUnreconstructableAgentCleanups = (args: {
  runtimeStore: CleanupRuntimeStore;
  notifyThreadActivityUpdated: (conversationId: string) => void;
  now?: number;
  expiryMs?: number;
}): number | null => {
  const reconciled = args.runtimeStore.reconcilePendingAgentCleanupRecords({
    resourcesVerifiedFree: false,
    ...(args.now == null ? {} : { now: args.now }),
    expiryMs: args.expiryMs ?? AGENT_PENDING_CLEANUP_EXPIRY_MS,
  });
  notifyReconciledConversations(
    reconciled,
    args.notifyThreadActivityUpdated,
  );
  return args.runtimeStore.getNextPendingAgentCleanupExpiryAt();
};

export const reconcilePersistedAgentCleanups = async (args: {
  controller: Pick<SelfModHmrController, "forceResumeAll" | "getStatus">;
  runtimeStore: CleanupRuntimeStore;
  notifyThreadActivityUpdated: (conversationId: string) => void;
  now?: number;
  expiryMs?: number;
}): Promise<boolean> => {
  const resumed = await args.controller.forceResumeAll().catch((error) => {
    console.error(
      "[self-mod-hmr] Failed to clear stale Vite state during worker initialization:",
      (error as Error).message,
    );
    return false;
  });
  const status = resumed ? await args.controller.getStatus() : null;
  const resourcesVerifiedFree = Boolean(
    resumed &&
    status &&
    !status.paused &&
    status.inFlightPaths === 0 &&
    status.appliedOverlayPaths === 0,
  );
  const reconciled = args.runtimeStore.reconcilePendingAgentCleanupRecords({
    resourcesVerifiedFree,
    ...(args.now == null ? {} : { now: args.now }),
    expiryMs: args.expiryMs ?? AGENT_PENDING_CLEANUP_EXPIRY_MS,
  });
  notifyReconciledConversations(
    reconciled,
    args.notifyThreadActivityUpdated,
  );
  if (!resourcesVerifiedFree) {
    console.error(
      "[self-mod-hmr] Startup cleanup could not verify that HMR pins and client-update guards are fully released; persistent Activity diagnostics remain active.",
    );
  }
  return resourcesVerifiedFree;
};
