import { internal } from "../_generated/api";
import { Infer, type Value } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { RunAgentTurnResult } from "../automation/runner";
import { optionalChannelEnvelopeValidator } from "../shared_validators";
import {
  ensureOwnerConnection,
  resolveConnectionForIncomingMessage,
} from "./routing_flow";
import { sleep } from "../lib/async";
import {
  buildDesktopTurnCandidates,
  runAgentTurnWithBackendFallback,
} from "../scheduling/desktop_handoff_policy";
import { AGENT_IDS } from "../lib/agent_constants";
import {
  EXECUTION_NOT_AVAILABLE_MESSAGE,
  shouldUseOfflineResponderForProvider,
} from "./execution_policy";

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

type HandleConnectorIncomingMessageArgs = Omit<ProcessIncomingMessageArgs, "ctx"> & {
  ctx: ActionCtx;
  logPrefix: string;
  notLinkedText: string;
  failureText?: string;
  sendReply: (text: string) => Promise<void>;
  onResult?: (result: { text: string; deferred?: boolean } | null) => void;
};

type FreshDeviceOption = {
  deviceId: string;
  deviceName: string;
  platform?: string;
  lastHeartbeatAt: number;
};

type PendingDeviceSelectionState = {
  createdAt: number;
  provider: string;
  promptText: string;
  userMessageId?: Id<"events">;
  attachments?: ChannelInboundAttachment[];
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
  deliveryMeta: Value;
  deviceOptions: Array<{
    deviceId: string;
    deviceName: string;
    platform?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DM_POLICY_DEFAULT = "pairing" as const;
export const SYNC_MODE_OFF: SyncMode = "off";
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : {};

const formatDeviceLabel = (device: {
  deviceName: string;
  platform?: string;
}): string =>
  device.platform ? `${device.deviceName} (${device.platform})` : device.deviceName;

const buildDeviceSelectionPrompt = (
  devices: Array<{ deviceId: string; deviceName: string; platform?: string }>,
  prefix?: string,
): string => {
  const lines = [
    prefix ?? "Multiple devices are online. Which device should I use?",
    ...devices.map((device, index) => `${index + 1}. ${formatDeviceLabel(device)}`),
    "Reply with the number or device name.",
  ];
  return lines.join("\n");
};

const parseDeviceSelectionReply = (
  replyText: string,
  deviceOptions: Array<{ deviceId: string; deviceName: string; platform?: string }>,
) => {
  const trimmed = replyText.trim();
  if (!trimmed) return null;

  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= deviceOptions.length) {
    return deviceOptions[index - 1] ?? null;
  }

  const normalized = trimmed.toLowerCase();
  const exactMatch = deviceOptions.find((device) =>
    device.deviceName.trim().toLowerCase() === normalized
    || formatDeviceLabel(device).trim().toLowerCase() === normalized,
  );
  if (exactMatch) return exactMatch;

  const prefixMatches = deviceOptions.filter((device) =>
    device.deviceName.trim().toLowerCase().startsWith(normalized)
    || formatDeviceLabel(device).trim().toLowerCase().startsWith(normalized),
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
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

const listFreshDevicesForOwner = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  nowMs: number;
}): Promise<FreshDeviceOption[]> => {
  return await args.ctx.runQuery(
    internal.agent.device_resolver.listFreshDevicesForOwner,
    { ownerId: args.ownerId, nowMs: args.nowMs },
  );
};

const getConversationRoutingState = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
}): Promise<{
  activeTargetDeviceId: string | null;
  pendingDeviceSelection: PendingDeviceSelectionState | null;
}> => {
  return await args.ctx.runQuery(
    internal.conversations.getRoutingState,
    { conversationId: args.conversationId },
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
  const nowMs = Date.now();
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

  const persistUser = async (params: {
    text: string;
    attachments?: ChannelInboundAttachment[];
    channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
  }): Promise<Id<"events"> | null> => {
    if (transient && transientBatchKey) {
      await appendTransientChannelEvent({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        direction: "inbound",
        text: params.text,
        batchKey: transientBatchKey,
        metadata: {
          source: "connector",
          syncMode,
        },
      });
      return null;
    }

    return await appendInboundUserMessage({
      ctx: args.ctx,
      conversationId,
      provider: args.provider,
      text: params.text,
      attachments: params.attachments,
      channelEnvelope: params.channelEnvelope,
    });
  };

  try {
    if (args.respond === false) {
      await persistUser({
        text: args.text,
        attachments: args.attachments,
        channelEnvelope: args.channelEnvelope,
      });
      return { text: "" };
    }

    const [routingState, freshDevices] = await Promise.all([
      getConversationRoutingState({
        ctx: args.ctx,
        conversationId,
      }),
      listFreshDevicesForOwner({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        nowMs,
      }),
    ]);
    const freshDeviceIds = new Set(freshDevices.map((device) => device.deviceId));

    let promptText = args.text;
    let promptAttachments = args.attachments;
    let promptChannelEnvelope = args.channelEnvelope;
    let promptDeliveryMeta = args.deliveryMeta;
    let pendingPromptUserMessageId: Id<"events"> | null = null;
    let targetDeviceId: string | null = null;

    if (routingState.pendingDeviceSelection) {
      const pendingSelection = routingState.pendingDeviceSelection;
      const selectedOption = parseDeviceSelectionReply(
        args.text,
        pendingSelection.deviceOptions,
      );

      if (!selectedOption) {
        const responseText = buildDeviceSelectionPrompt(
          pendingSelection.deviceOptions,
          "I couldn't match that choice.",
        );
        await persistUser({
          text: args.text,
          attachments: args.attachments,
          channelEnvelope: args.channelEnvelope,
        });
        await persistAssistant({ text: responseText });
        return { text: responseText };
      }

      const freshMatch = freshDevices.find(
        (device) => device.deviceId === selectedOption.deviceId,
      );
      if (!freshMatch) {
        if (freshDevices.length === 0) {
          await args.ctx.runMutation(
            internal.conversations.clearPendingDeviceSelection,
            { conversationId },
          );
          await args.ctx.runMutation(
            internal.conversations.setActiveTargetDeviceId,
            { conversationId, deviceId: undefined },
          );
          promptText = pendingSelection.promptText;
          promptAttachments = pendingSelection.attachments;
          promptChannelEnvelope = pendingSelection.channelEnvelope;
          promptDeliveryMeta = asRecord(pendingSelection.deliveryMeta);
          pendingPromptUserMessageId = pendingSelection.userMessageId ?? null;
        } else {
          const refreshedOptions = freshDevices.map((device) => ({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            platform: device.platform,
          }));
          await args.ctx.runMutation(
            internal.conversations.setPendingDeviceSelection,
            {
              conversationId,
              selection: {
                ...pendingSelection,
                createdAt: nowMs,
                deviceOptions: refreshedOptions,
              },
            },
          );
          const responseText = buildDeviceSelectionPrompt(
            refreshedOptions,
            `${selectedOption.deviceName} is no longer online.`,
          );
          await persistUser({
            text: args.text,
            attachments: args.attachments,
            channelEnvelope: args.channelEnvelope,
          });
          await persistAssistant({ text: responseText });
          return { text: responseText };
        }
      } else {
        await args.ctx.runMutation(
          internal.conversations.clearPendingDeviceSelection,
          { conversationId },
        );
        await args.ctx.runMutation(
          internal.conversations.setActiveTargetDeviceId,
          { conversationId, deviceId: freshMatch.deviceId },
        );
        promptText = pendingSelection.promptText;
        promptAttachments = pendingSelection.attachments;
        promptChannelEnvelope = pendingSelection.channelEnvelope;
        promptDeliveryMeta = asRecord(pendingSelection.deliveryMeta);
        pendingPromptUserMessageId = pendingSelection.userMessageId ?? null;
        targetDeviceId = freshMatch.deviceId;
      }
    } else if (
      routingState.activeTargetDeviceId
      && freshDeviceIds.has(routingState.activeTargetDeviceId)
    ) {
      targetDeviceId = routingState.activeTargetDeviceId;
    } else {
      if (routingState.activeTargetDeviceId) {
        await args.ctx.runMutation(
          internal.conversations.setActiveTargetDeviceId,
          { conversationId, deviceId: undefined },
        );
      }

      if (freshDevices.length === 1) {
        targetDeviceId = freshDevices[0]?.deviceId ?? null;
        if (targetDeviceId) {
          await args.ctx.runMutation(
            internal.conversations.setActiveTargetDeviceId,
            { conversationId, deviceId: targetDeviceId },
          );
        }
      } else if (freshDevices.length > 1) {
        const deviceOptions = freshDevices.map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
        }));
        const userMessageId = await persistUser({
          text: args.text,
          attachments: args.attachments,
          channelEnvelope: args.channelEnvelope,
        });
        const responseText = buildDeviceSelectionPrompt(deviceOptions);
        await args.ctx.runMutation(
          internal.conversations.setPendingDeviceSelection,
          {
            conversationId,
            selection: {
              createdAt: nowMs,
              provider: args.provider,
              promptText: args.text,
              ...(userMessageId ? { userMessageId } : {}),
              attachments: args.attachments,
              channelEnvelope: args.channelEnvelope,
              deliveryMeta: JSON.parse(JSON.stringify(args.deliveryMeta ?? {})) as Value,
              deviceOptions,
            },
          },
        );
        await persistAssistant({ text: responseText });
        return { text: responseText };
      }
    }

    const userMessageId =
      pendingPromptUserMessageId ??
      (await persistUser({
        text: promptText,
        attachments: promptAttachments,
        channelEnvelope: promptChannelEnvelope,
      }));

    console.log(
      `[pipeline:trace] conversationRouting: ownerId=${connection.ownerId}, activeTargetDeviceId=${routingState.activeTargetDeviceId ?? "none"}, freshDevices=${freshDevices.length}, targetDeviceId=${targetDeviceId}`,
    );

    const candidates = buildDesktopTurnCandidates({
      targetDeviceId,
    });
    console.log(
      `[pipeline:trace] candidates: ${JSON.stringify(candidates.map((c) => c.mode))}, deliveryMeta=${!!args.deliveryMeta}, userMessageId=${!!userMessageId}, transient=${transient}`,
    );
    const allowOfflineResponder = shouldUseOfflineResponderForProvider(args.provider);

    // ─── Inverted Execution: defer to local device ──────────────────────
    // When the local device is online and delivery metadata is provided,
    // insert a remote_turn_request event and return immediately. The local
    // device runs the AI SDK natively (0ms tool latency) and delivers the
    // response back to the connector asynchronously.
    const firstCandidate = candidates[0];
    if (
      firstCandidate?.mode === "desktop" &&
      promptDeliveryMeta
    ) {
      const requestId = crypto.randomUUID();

      const clonedDeliveryMeta = JSON.parse(JSON.stringify(promptDeliveryMeta));

      const turnPayload = {
        conversationId: String(conversationId),
        ...(userMessageId ? { userMessageId: String(userMessageId) } : {}),
        text: promptText,
        provider: args.provider,
        deliveryMeta: clonedDeliveryMeta,
      };

      await args.ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId,
        type: "remote_turn_request",
        targetDeviceId: firstCandidate.targetDeviceId,
        requestId,
        payload: turnPayload,
      });

      // Schedule a fast rescue only for the mobile app's backend offline
      // responder. For desktop-routed connectors, a delayed claim should not
      // be treated as "desktop offline"; the orphan watchdog handles true
      // failures later if the request never completes.
      if (allowOfflineResponder) {
        await args.ctx.runMutation(
          internal.channels.connector_delivery.scheduleRescue,
          {
            requestId,
            conversationId,
            ownerId: connection.ownerId,
            prompt: promptText,
            provider: args.provider,
            deliveryMeta: clonedDeliveryMeta,
            ...(userMessageId ? { userMessageId: String(userMessageId) } : {}),
            targetDeviceId: firstCandidate.targetDeviceId,
          },
        );
      }

      console.log(
        `[channels] Deferred to local device (inverted execution): ${requestId}`,
      );
      return { text: "", deferred: true };
    }

    if (!allowOfflineResponder) {
      const failureMessage = EXECUTION_NOT_AVAILABLE_MESSAGE;
      await persistAssistant({
        text: failureMessage,
        fallback: "none",
      });
      return { text: failureMessage };
    }

    let result: RunAgentTurnResult | null = null;
    let selectedMode: "desktop" | "backend" | null = null;
    try {
      const outcome = await runAgentTurnWithBackendFallback({
        ctx: args.ctx,
        conversationId,
        prompt: promptText,
        agentType: AGENT_IDS.OFFLINE_RESPONDER,
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
    const usedBackendFallback =
      !targetDeviceId &&
      selectedMode === "backend";

    await persistAssistant({
      text: responseText,
      usage: result.usage,
      silent: result.silent,
      fallback: usedBackendFallback ? "backend" : selectedMode ?? undefined,
    });

    return { text: responseText };
  } catch (error) {
    console.error("[channels] processIncomingMessage failed:", error);
    throw error;
  } finally {
    // Always clear transient connector rows, including unexpected error paths.
    await cleanupTransientBatch();
  }
}

export async function handleConnectorIncomingMessage(
  args: HandleConnectorIncomingMessageArgs,
): Promise<void> {
  const shouldRespond = args.respond !== false;

  try {
    const result = await processIncomingMessage({
      ctx: args.ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: args.text,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      displayName: args.displayName,
      preEnsureOwnerConnection: args.preEnsureOwnerConnection,
      respond: args.respond,
      deliveryMeta: args.deliveryMeta,
    });

    args.onResult?.(result);
    if (result?.deferred) return;

    if (!result) {
      if (shouldRespond) {
        await args.sendReply(args.notLinkedText);
      }
      return;
    }

    if (shouldRespond) {
      await args.sendReply(result.text);
    }
  } catch (error) {
    console.error(`${args.logPrefix} Connector pipeline failed:`, error);
    if (shouldRespond) {
      await args.sendReply(args.failureText ?? "Sorry, something went wrong. Please try again.");
    }
  }
}
