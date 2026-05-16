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

        if (!conversationId || !userPrompt) {
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
          userPrompt,
          agentType,
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
