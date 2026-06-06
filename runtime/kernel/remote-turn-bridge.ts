const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const BUSY_RETRY_MS = 1_000;
const ERROR_RETRY_MS = 5_000;
const EMPTY_RESPONSE_TEXT = "(Stella had nothing to say.)";

export type RemoteTurnRequestEvent = {
  _id: string;
  timestamp: number;
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: Record<string, unknown>;
};

type RemoteTurnRunResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

type PendingRemoteTurn = {
  event: RemoteTurnRequestEvent;
  nextAttemptAt: number;
};

type RemoteTurnBridgeOptions = {
  startupLookbackMs?: number;
};

type RemoteTurnBridgeDeps = {
  deviceId: string;
  isEnabled: () => boolean;
  isRunnerBusy: () => boolean;
  subscribeRemoteTurnRequests: (args: {
    deviceId: string;
    since: number;
    onUpdate: (events: RemoteTurnRequestEvent[]) => void;
    onError?: (error: Error) => void;
  }) => () => void;
  runLocalTurn: (args: {
    requestId: string;
    conversationId: string;
    userPrompt: string;
    agentType?: string;
    modelOverride?: string;
    provider?: string;
    externalMessageId?: string;
    attachments?: Array<{
      url: string;
      mimeType?: string;
      kind?: string;
      name?: string;
      size?: number;
      transcript?: string;
      extractedText?: string;
    }>;
  }) => Promise<RemoteTurnRunResult>;
  claimRemoteTurn?: (args: {
    requestId: string;
    conversationId: string;
  }) => Promise<void>;
  completeConnectorTurn: (args: {
    requestId: string;
    conversationId: string;
    text: string;
  }) => Promise<void>;
  log?: (level: "warn" | "error", message: string, error?: unknown) => void;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const getTrimmedString = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

type RuntimeAttachment = {
  url: string;
  mimeType?: string;
  kind?: string;
  name?: string;
  size?: number;
  transcript?: string;
  extractedText?: string;
};

/**
 * Parse a payload's `mediaRefs` (set by the backend after relaying inbound
 * attachments through R2) into the shape the runtime expects. We preserve
 * `kind`/`name`/`size` even though the worker's image materializer only
 * acts on images today — those fields are needed for future non-image
 * support (voice notes, documents) without another round of plumbing.
 */
const getRuntimeAttachments = (value: unknown): RuntimeAttachment[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): RuntimeAttachment | null => {
      const record = asRecord(entry);
      const url = getTrimmedString(record?.url);
      if (!url) return null;
      const mimeType = getTrimmedString(record?.mimeType) || undefined;
      const kind = getTrimmedString(record?.kind) || undefined;
      const name = getTrimmedString(record?.name) || undefined;
      const sizeRaw = record?.size;
      const size =
        typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw >= 0
          ? sizeRaw
          : undefined;
      const transcript = getTrimmedString(record?.transcript) || undefined;
      const extractedText =
        getTrimmedString(record?.extractedText) || undefined;
      return {
        url,
        ...(mimeType ? { mimeType } : {}),
        ...(kind ? { kind } : {}),
        ...(name ? { name } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(transcript ? { transcript } : {}),
        ...(extractedText ? { extractedText } : {}),
      };
    })
    .filter((entry): entry is RuntimeAttachment => Boolean(entry));
};

const isAttachmentOnlyPlaceholder = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "[attachment]" ||
    normalized === "[audio]" ||
    normalized === "[voice message]" ||
    normalized === "the user sent an attachment."
  );
};

const isAudioAttachment = (attachment: RuntimeAttachment): boolean => {
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  const kind = attachment.kind?.toLowerCase() ?? "";
  return (
    mimeType.startsWith("audio/") ||
    kind.includes("audio") ||
    kind.includes("voice")
  );
};

const userPromptWithAttachmentContext = (
  userPrompt: string,
  attachments: RuntimeAttachment[],
): string => {
  const audioAttachments = attachments.filter(isAudioAttachment);
  const textAttachments = attachments.filter((attachment) =>
    Boolean(attachment.extractedText),
  );

  const transcriptBlocks = audioAttachments
    .map((attachment, index) => {
      if (!attachment.transcript) return null;
      const label =
        audioAttachments.length === 1
          ? "Voice message transcript"
          : `Voice message ${index + 1} transcript`;
      return `${label}:\n${attachment.transcript}`;
    })
    .filter((block): block is string => Boolean(block));

  const textBlocks = textAttachments
    .map((attachment, index) => {
      if (!attachment.extractedText) return null;
      const label =
        attachment.name ||
        (textAttachments.length === 1
          ? "Attached file text"
          : `Attached file ${index + 1} text`);
      return `${label}:\n${attachment.extractedText}`;
    })
    .filter((block): block is string => Boolean(block));

  const contextBlocks = [...transcriptBlocks, ...textBlocks];
  if (contextBlocks.length > 0) {
    const contextText = contextBlocks.join("\n\n");
    return isAttachmentOnlyPlaceholder(userPrompt)
      ? contextText
      : `${userPrompt}\n\n${contextText}`;
  }

  if (audioAttachments.length > 0) {
    const fallback = "The user sent an audio attachment, but it could not be transcribed.";
    return isAttachmentOnlyPlaceholder(userPrompt)
      ? fallback
      : `${userPrompt}\n\n${fallback}`;
  }

  return userPrompt;
};

const isConnectorRequest = (payload: Record<string, unknown> | null): boolean => {
  const source = getTrimmedString(payload?.source);
  return source !== "cron";
};

const sortEventsAsc = (left: RemoteTurnRequestEvent, right: RemoteTurnRequestEvent) => {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left._id.localeCompare(right._id);
};

export const createRemoteTurnBridge = (
  deps: RemoteTurnBridgeDeps,
  options: RemoteTurnBridgeOptions = {},
) => {
  const startupLookbackMs = options.startupLookbackMs ?? DEFAULT_LOOKBACK_MS;

  let running = false;
  let processing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeRemoteTurns: (() => void) | null = null;
  const pending = new Map<string, PendingRemoteTurn>();

  const clearRetryTimer = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (delayMs: number) => {
    if (!running) {
      return;
    }
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      void processPending();
    }, Math.max(0, delayMs));
  };

  const syncPendingWithSubscription = (events: RemoteTurnRequestEvent[]) => {
    const activeRequestIds = new Set<string>();

    for (const event of [...events].sort(sortEventsAsc)) {
      const requestId = getTrimmedString(event.requestId);
      if (!requestId) {
        continue;
      }

      if (!isConnectorRequest(asRecord(event.payload))) {
        continue;
      }

      activeRequestIds.add(requestId);
      if (!pending.has(requestId)) {
        pending.set(requestId, {
          event,
          nextAttemptAt: Date.now(),
        });
      } else {
        const existing = pending.get(requestId)!;
        pending.set(requestId, {
          event,
          nextAttemptAt: existing.nextAttemptAt,
        });
      }
    }

    for (const requestId of [...pending.keys()]) {
      if (!activeRequestIds.has(requestId)) {
        pending.delete(requestId);
      }
    }

    void processPending();
  };

  const processPending = async () => {
    if (processing || !running || !deps.isEnabled()) {
      return;
    }
    if (deps.isRunnerBusy()) {
      scheduleRetry(BUSY_RETRY_MS);
      return;
    }

    processing = true;
    try {
      while (running && deps.isEnabled() && !deps.isRunnerBusy()) {
        const now = Date.now();
        const next = [...pending.values()]
          .filter((entry) => entry.nextAttemptAt <= now)
          .sort((left, right) => sortEventsAsc(left.event, right.event))[0];

        if (!next) {
          const earliestRetryAt = [...pending.values()]
            .map((entry) => entry.nextAttemptAt)
            .sort((left, right) => left - right)[0];
          if (typeof earliestRetryAt === "number") {
            scheduleRetry(Math.max(0, earliestRetryAt - Date.now()));
          }
          return;
        }

        const event = next.event;
        const requestId = getTrimmedString(event.requestId);
        if (!requestId) {
          continue;
        }

        const payload = asRecord(event.payload);
        const conversationId = getTrimmedString(payload?.conversationId);
        const userPrompt = getTrimmedString(payload?.text);
        const agentType = getTrimmedString(payload?.agentType) || undefined;
        const provider = getTrimmedString(payload?.provider) || undefined;
        const channelEnvelope = asRecord(event.channelEnvelope);
        const externalMessageId =
          getTrimmedString(channelEnvelope?.externalMessageId) || undefined;
        const deliveryMeta = asRecord(payload?.deliveryMeta);
        const modelOverride =
          getTrimmedString(deliveryMeta?.mobileModel) || undefined;
        const attachments = getRuntimeAttachments(payload?.mediaRefs);
        const effectiveUserPrompt = userPromptWithAttachmentContext(
          userPrompt,
          attachments,
        );

        if (!conversationId || (!effectiveUserPrompt && attachments.length === 0)) {
          pending.delete(requestId);
          deps.log?.(
            "warn",
            `[remote-turn] Dropping malformed request ${requestId}.`,
          );
          continue;
        }

        // Claim immediately so the rescue timer knows we're handling it
        await deps.claimRemoteTurn?.({ requestId, conversationId }).catch((err) => {
          deps.log?.(
            "warn",
            `[remote-turn] claimRemoteTurn failed for ${requestId} (rescue will run if unclaimed): ${
              err instanceof Error ? err.message : String(err)
            }`,
            err,
          );
        });

        const result = await deps.runLocalTurn({
          requestId,
          conversationId,
          userPrompt: effectiveUserPrompt || "The user sent an attachment.",
          agentType,
          modelOverride,
          provider,
          externalMessageId,
          attachments,
        });

        if (result.status === "busy") {
          pending.set(requestId, {
            event,
            nextAttemptAt: Date.now() + BUSY_RETRY_MS,
          });
          scheduleRetry(BUSY_RETRY_MS);
          return;
        }

        if (result.status === "error") {
          pending.set(requestId, {
            event,
            nextAttemptAt: Date.now() + ERROR_RETRY_MS,
          });
          deps.log?.(
            "warn",
            `[remote-turn] Local run failed for ${requestId}: ${result.error}`,
          );
          scheduleRetry(ERROR_RETRY_MS);
          return;
        }

        const finalText = result.finalText.trim() || EMPTY_RESPONSE_TEXT;
        await deps.completeConnectorTurn({
          requestId,
          conversationId,
          text: finalText,
        });
        pending.delete(requestId);
      }
    } finally {
      processing = false;
    }
  };

  const start = () => {
    if (unsubscribeRemoteTurns) {
      unsubscribeRemoteTurns();
      unsubscribeRemoteTurns = null;
    }
    running = true;
    unsubscribeRemoteTurns = deps.subscribeRemoteTurnRequests({
      deviceId: deps.deviceId,
      since: Date.now() - startupLookbackMs,
      onUpdate: syncPendingWithSubscription,
      onError: (error) => {
        deps.log?.("error", "[remote-turn] Subscription failed.", error);
      },
    });
  };

  const stop = () => {
    running = false;
    clearRetryTimer();
    unsubscribeRemoteTurns?.();
    unsubscribeRemoteTurns = null;
    pending.clear();
  };

  const kick = () => {
    if (!running) {
      return;
    }
    clearRetryTimer();
    void processPending();
  };

  return {
    start,
    stop,
    kick,
    getPendingRequestIds: () => [...pending.keys()],
  };
};
