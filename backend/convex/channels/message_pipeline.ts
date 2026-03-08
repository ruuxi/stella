import { internal } from "../_generated/api";
import { Infer } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { RunAgentTurnResult } from "../automation/runner";
import { optionalChannelEnvelopeValidator } from "../shared_validators";
import {
  ensureOwnerConnection,
  isOwnerInConnectedMode,
  resolveConnectionForIncomingMessage,
} from "./routing_flow";
import { sleep } from "../lib/async";
import {
  buildDesktopTurnCandidates,
  runAgentTurnWithCloudFallback,
} from "../scheduling/desktop_handoff_policy";

const BACKEND_FALLBACK_AGENT_TYPE = "offline_responder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncMode = "on" | "off";

export type ChannelInboundAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  size?: number;
  kind?: string;
};

type ProcessIncomingMessageArgs = {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
  text: string;
  groupId?: string;
  attachments?: ChannelInboundAttachment[];
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
  displayName?: string;
  preEnsureOwnerConnection?: boolean;
  respond?: boolean;
  /** Provider-specific delivery metadata for async connector delivery. */
  deliveryMeta?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DM_POLICY_DEFAULT = "pairing" as const;
export const SYNC_MODE_OFF: SyncMode = "off";
export const CONNECTED_MODE_REQUIRED_MESSAGE =
  "Connectors are disabled in Private Local mode. Enable Connected mode in Stella Settings to continue.";
export const EXECUTION_NOT_AVAILABLE_MESSAGE =
  "Your desktop is offline right now. Open Stella on your desktop and try again.";
export const TRANSIENT_CLEANUP_MAX_ATTEMPTS = 4;
export const TRANSIENT_CLEANUP_BACKOFF_BASE_MS = 100;
export const TRANSIENT_CLEANUP_BACKOFF_MAX_MS = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toErrorMessage = (value: unknown): string | undefined => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
};

const getTransientCleanupBackoffMs = (attempt: number): number =>
  Math.min(
    TRANSIENT_CLEANUP_BACKOFF_MAX_MS,
    TRANSIENT_CLEANUP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );

const resolveConversationIdForIncomingMessage = async (args: {
  ctx: ActionCtx;
  provider: string;
  ownerId: string;
  groupId?: string;
}): Promise<Id<"conversations">> => {
  if (!args.groupId) {
    return await args.ctx.runMutation(
      internal.channels.utils.getOrCreateConversationForOwner,
      { ownerId: args.ownerId },
    );
  }

  const groupKey = `group:${args.groupId}`;
  let groupConnection = await args.ctx.runQuery(
    internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
    {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: groupKey,
    },
  );

  if (!groupConnection) {
    groupConnection = await ensureOwnerConnection({
      ctx: args.ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: groupKey,
    });
  }

  if (groupConnection?.conversationId) {
    return groupConnection.conversationId;
  }

  const conversationId = await args.ctx.runMutation(
    internal.channels.utils.createGroupConversation,
    { ownerId: args.ownerId, title: `${args.provider} group` },
  );

  if (groupConnection) {
    await args.ctx.runMutation(internal.channels.utils.setConnectionConversation, {
      connectionId: groupConnection._id,
      conversationId,
    });
  }

  return conversationId;
};

const appendInboundUserMessage = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  provider: string;
  text: string;
  attachments?: ChannelInboundAttachment[];
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
}): Promise<Id<"events"> | null> => {
  const event = await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "user_message",
    deviceId: `channel:${args.provider}`,
    payload: {
      text: args.text,
      source: `channel:${args.provider}`,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: args.attachments }
        : {}),
    },
    channelEnvelope: args.channelEnvelope,
  });
  return event?._id ?? null;
};

const appendTransientChannelEvent = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  conversationId: Id<"conversations">;
  provider: string;
  direction: "inbound" | "outbound";
  text: string;
  batchKey: string;
  runId?: string;
  metadata?: {
    source?: string;
    syncMode?: string;
    fallback?: string;
  };
}): Promise<void> => {
  await args.ctx.runMutation(internal.channels.transient_data.appendTransientEvent, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    provider: args.provider,
    direction: args.direction,
    text: args.text,
    batchKey: args.batchKey,
    runId: args.runId,
    metadata: args.metadata,
  });
};

const deleteTransientBatch = async (args: {
  ctx: ActionCtx;
  batchKey: string;
}): Promise<void> => {
  await args.ctx.runMutation(internal.channels.transient_data.deleteTransientBatch, {
    batchKey: args.batchKey,
  });
};

const resolveExecutionTarget = async (args: {
  ctx: ActionCtx;
  ownerId: string;
}): Promise<{ targetDeviceId: string | null }> => {
  return await args.ctx.runQuery(
    internal.agent.device_resolver.resolveExecutionTarget,
    { ownerId: args.ownerId },
  );
};

const persistInboundAssistantMessage = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  provider: string;
  responseText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): Promise<void> => {
  await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "assistant_message",
    payload: {
      text: args.responseText,
      source: `channel:${args.provider}`,
      ...(args.usage ? { usage: args.usage } : {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

/**
 * Common message handling: lookup connection -> resolve conversation ->
 * append event -> resolve execution target -> run agent turn -> return response.
 *
 * Conversation routing:
 * - DMs (groupId absent): route to the owner's default conversation
 * - Groups (groupId present): route to a per-group conversation
 */
export async function processIncomingMessage(
  args: ProcessIncomingMessageArgs,
): Promise<{ text: string; deferred?: boolean } | null> {
  if (args.ownerId && !(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId: args.ownerId }))) {
    if (args.respond === false) {
      return { text: "" };
    }
    return { text: CONNECTED_MODE_REQUIRED_MESSAGE };
  }

  const connection = await resolveConnectionForIncomingMessage({
    ctx: args.ctx,
    ownerId: args.ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
    preEnsureOwnerConnection: args.preEnsureOwnerConnection,
  });
  if (!connection) {
    return null;
  }

  if (!(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId: connection.ownerId }))) {
    if (args.respond === false) {
      return { text: "" };
    }
    return { text: CONNECTED_MODE_REQUIRED_MESSAGE };
  }

  const conversationId = await resolveConversationIdForIncomingMessage({
    ctx: args.ctx,
    provider: args.provider,
    ownerId: connection.ownerId,
    groupId: args.groupId,
  });
  const syncMode = (await args.ctx.runQuery(
    internal.data.preferences.getSyncModeForOwner,
    { ownerId: connection.ownerId },
  )) as SyncMode;
  // See backend/docs/sync_off_operational_writes.md for intentionally retained
  // operational metadata writes while sync mode is off.
  const transient = syncMode === SYNC_MODE_OFF;
  const transientBatchKey = transient
    ? `channel:${args.provider}:${crypto.randomUUID()}`
    : null;
  let transientBatchCleaned = false;
  const cleanupTransientBatch = async () => {
    if (!transientBatchKey || transientBatchCleaned) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= TRANSIENT_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deleteTransientBatch({ ctx: args.ctx, batchKey: transientBatchKey });
        transientBatchCleaned = true;
        return;
      } catch (cleanupError) {
        lastError = cleanupError;
        console.error(
          `[channels] Transient connector cleanup attempt ${attempt}/${TRANSIENT_CLEANUP_MAX_ATTEMPTS} failed:`,
          cleanupError,
        );
        if (attempt < TRANSIENT_CLEANUP_MAX_ATTEMPTS) {
          await sleep(getTransientCleanupBackoffMs(attempt));
        }
      }
    }

    const errorMessage = toErrorMessage(lastError);
    try {
      await args.ctx.runMutation(internal.channels.transient_data.recordCleanupFailure, {
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        batchKey: transientBatchKey,
        attempts: TRANSIENT_CLEANUP_MAX_ATTEMPTS,
        errorMessage,
      });
    } catch (reportError) {
      // best-effort: this is a fallback for an already-failed cleanup; throwing would mask the original error
      console.error("[channels] Failed to persist transient cleanup failure metric:", reportError);
    }

    // best-effort: cleanup runs in `finally`; throwing here would mask the original pipeline result
    console.error("[channels][ALERT] Failed to clean transient connector batch after retries.", {
      ownerId: connection.ownerId,
      provider: args.provider,
      attempts: TRANSIENT_CLEANUP_MAX_ATTEMPTS,
      ...(errorMessage ? { errorMessage } : {}),
    });
  };

  const persistAssistant = async (params: {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    silent?: boolean;
    fallback?: string;
  }) => {
    if (params.silent) return;
    if (transient && transientBatchKey) {
      await appendTransientChannelEvent({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        direction: "outbound",
        text: params.text,
        batchKey: transientBatchKey,
        metadata: {
          source: "connector",
          syncMode,
          ...(params.fallback ? { fallback: params.fallback } : {}),
        },
      });
      return;
    }

    await persistInboundAssistantMessage({
      ctx: args.ctx,
      conversationId,
      provider: args.provider,
      responseText: params.text,
      usage: params.usage,
    });
  };

  try {
    const userMessageId = transient
      ? null
      : await appendInboundUserMessage({
          ctx: args.ctx,
          conversationId,
          provider: args.provider,
          text: args.text,
          attachments: args.attachments,
          channelEnvelope: args.channelEnvelope,
        });

    if (transient && transientBatchKey) {
      await appendTransientChannelEvent({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        direction: "inbound",
        text: args.text,
        batchKey: transientBatchKey,
        metadata: {
          source: "connector",
          syncMode,
        },
      });
    }

    if (args.respond === false) {
      return { text: "" };
    }

    const executionTarget = await resolveExecutionTarget({
      ctx: args.ctx,
      ownerId: connection.ownerId,
    });

    const candidates = buildDesktopTurnCandidates({
      targetDeviceId: executionTarget.targetDeviceId,
    });

    // ─── Inverted Execution: defer to local device ──────────────────────
    // When the local device is online and delivery metadata is provided,
    // insert a remote_turn_request event and return immediately. The local
    // device runs the AI SDK natively (0ms tool latency) and delivers the
    // response back to the connector asynchronously.
    const firstCandidate = candidates[0];
    if (
      firstCandidate?.mode === "desktop" &&
      args.deliveryMeta &&
      userMessageId &&
      !transient
    ) {
      const requestId = crypto.randomUUID();

      await args.ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId,
        type: "remote_turn_request",
        targetDeviceId: firstCandidate.targetDeviceId,
        requestId,
        payload: {
          conversationId: String(conversationId),
          userMessageId: String(userMessageId),
          text: args.text,
          provider: args.provider,
          deliveryMeta: JSON.parse(JSON.stringify(args.deliveryMeta)),
        },
      });

      console.log(
        `[channels] Deferred to local device (inverted execution): ${requestId}`,
      );
      return { text: "", deferred: true };
    }

    let result: RunAgentTurnResult | null = null;
    let selectedMode: "desktop" | "cloud" | null = null;
    try {
      const outcome = await runAgentTurnWithCloudFallback({
        ctx: args.ctx,
        conversationId,
        prompt: args.text,
        agentType: BACKEND_FALLBACK_AGENT_TYPE,
        ownerId: connection.ownerId,
        userMessageId: userMessageId ?? undefined,
        transient,
        candidates,
      });
      result = outcome.result;
      selectedMode = outcome.selectedMode;
    } catch (error) {
      // Caught intentionally: fall through to the !result path which returns a user-facing failure message
      console.error("[channels] Agent turn failed across all execution candidates:", error);
    }

    if (!result) {
      const failureMessage = EXECUTION_NOT_AVAILABLE_MESSAGE;
      await persistAssistant({
        text: failureMessage,
        fallback: "none",
      });
      return { text: failureMessage };
    }

    const responseText = result.text.trim() || "(Stella had nothing to say.)";
    const usedCloudFallback =
      !executionTarget.targetDeviceId &&
      selectedMode === "cloud";

    await persistAssistant({
      text: responseText,
      usage: result.usage,
      silent: result.silent,
      fallback: usedCloudFallback ? "cloud" : selectedMode ?? undefined,
    });

    return { text: responseText };
  } catch (error) {
    // best-effort: connector webhook callers treat null as "no reply"; rethrowing would 500 the webhook
    console.error("[channels] processIncomingMessage failed:", error);
    return null;
  } finally {
    // Always clear transient connector rows, including unexpected error paths.
    await cleanupTransientBatch();
  }
}
