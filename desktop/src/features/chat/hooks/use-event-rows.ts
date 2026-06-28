import { useLayoutEffect, useMemo, useRef } from "react";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MessagePayload } from "@/features/chat/lib/event-transforms";
import {
  isAgentStartedEvent,
  isAssistantMessage,
  isUserMessage,
} from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";
import { isOfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import type { ScheduleToolAffectedRef } from "../../../../../runtime/kernel/shared/scheduling";
import {
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
} from "@/features/chat/lib/derive-turn-resource";
import { deriveTurnWebSearchResults } from "@/features/chat/lib/derive-turn-web-search";
import { filterMessagesForUiDisplay } from "@/features/chat/lib/message-display";
import {
  stabilizeTurnRows,
  type StableTurnRowsState,
} from "@/features/chat/lib/stable-rows";
import { eventRowEqual } from "@/features/chat/lib/row-equality";
import { useDeveloperResourcePreviewsEnabled } from "@/shared/lib/developer-resource-previews";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";
import {
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "@/features/chat/lib/message-turn-display";
import {
  assistantScrollFollowKey,
  type AgentResponseTarget,
} from "@/features/chat/streaming/streaming-types";

/**
 * Synthetic `_id` prefix carried by `StreamingAssistantOverlay` rows
 * merged into `displayMessages` by `useConversationDisplayMessages`.
 * The row builder uses this prefix to tag rows as `isStreaming: true`.
 */
const STREAMING_OVERLAY_ID_PREFIX = "stream-overlay:";

const getMessagePayload = (
  event?: EventRecord | MessageRecord,
): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== "object") return null;
  return event.payload as MessagePayload;
};

const getOfficePreviewRef = (events: readonly EventRecord[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type !== "tool_result") continue;
    const payload = event.payload as { officePreviewRef?: unknown } | undefined;
    const previewRef = payload?.officePreviewRef;
    if (isOfficePreviewRef(previewRef)) return previewRef;
  }
  return undefined;
};

/**
 * Pick out the latest `Schedule` tool_result on this assistant turn and
 * lift its structured `details.schedule.affected` payload (see
 * `ScheduleToolDetails` in `runtime/kernel/shared/scheduling.ts`). Returns
 * `undefined` for turns that didn't go through the Schedule tool, or
 * Schedule turns whose subagent reported "no_change".
 */
const getScheduleReceipt = (
  events: readonly EventRecord[],
): { affected: ScheduleToolAffectedRef[]; summary?: string } | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_result") continue;
    const payload = event.payload as
      | {
          toolName?: string;
          error?: string;
          schedule?: { affected?: unknown };
          resultPreview?: unknown;
          result?: unknown;
        }
      | undefined;
    if (!payload || payload.toolName !== "Schedule") continue;
    if (typeof payload.error === "string" && payload.error) return undefined;
    const schedule = payload.schedule;
    if (!schedule || typeof schedule !== "object") continue;
    const affected = (schedule as { affected?: unknown }).affected;
    if (!Array.isArray(affected) || affected.length === 0) continue;
    const summary =
      typeof payload.resultPreview === "string" && payload.resultPreview.trim()
        ? payload.resultPreview.trim()
        : typeof payload.result === "string" && payload.result.trim()
          ? payload.result.trim()
          : undefined;
    return {
      affected: affected as ScheduleToolAffectedRef[],
      ...(summary ? { summary } : {}),
    };
  }
  return undefined;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * Background-work threads kicked off (or re-activated) on this assistant
 * turn, read from the `agent-started` lifecycle events attached to the turn
 * — the same canonical source the sidebar Activity surface and live task
 * list use.
 *
 * Why the lifecycle event and not the `spawn_agent` tool_result: the spawn
 * handler returns its `thread_id` under `result`, which the runtime persists
 * only as a preview *string* (the structured object never lands on the
 * tool_result event payload), so the id isn't reliably recoverable there.
 * `agent-started` carries `agentId` directly. It also fires on `send_input`
 * re-activation (so updating a thread drops a fresh card lower in the chat)
 * and for agents spawned via `multi_tool_use_parallel`, and never fires for
 * a failed spawn (so no phantom card). Multiple in one turn collapse into a
 * single descriptor (one card that tallies them); the optional group label
 * becomes the card's title.
 */
const getBackgroundWork = (
  events: readonly EventRecord[],
):
  | {
      threadIds: string[];
      descriptions: Record<string, string>;
      spawnedAtMs: Record<string, number>;
      groupKey?: string;
      label?: string;
    }
  | undefined => {
  const threadIds: string[] = [];
  const descriptions: Record<string, string> = {};
  // When this thread was kicked off / last advanced on this turn (ms). Lets
  // the card distinguish a fresh spawn (read as working) from one whose
  // lifecycle aged out of the loaded windows (presume settled, not pinned
  // as forever-working).
  const spawnedAtMs: Record<string, number> = {};
  let groupKey: string | undefined;
  let label: string | undefined;
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    if (!threadIds.includes(agentId)) threadIds.push(agentId);
    const description = asNonEmptyString(event.payload.description);
    if (description && !descriptions[agentId])
      descriptions[agentId] = description;
    if (event.timestamp > (spawnedAtMs[agentId] ?? 0)) {
      spawnedAtMs[agentId] = event.timestamp;
    }
    if (!groupKey) groupKey = asNonEmptyString(event.payload.groupKey);
    if (!label) label = asNonEmptyString(event.payload.groupLabel);
  }
  if (threadIds.length === 0) return undefined;
  return {
    threadIds,
    descriptions,
    spawnedAtMs,
    ...(groupKey ? { groupKey } : {}),
    ...(label ? { label } : {}),
  };
};

const getCwd = (events: readonly EventRecord[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "tool_request") continue;
    const payload = event.payload as { args?: unknown } | undefined;
    if (!payload?.args || typeof payload.args !== "object") continue;
    const args = payload.args as Record<string, unknown>;
    const cwd =
      asNonEmptyString(args.working_directory) ??
      asNonEmptyString(args.workdir) ??
      asNonEmptyString(args.cwd);
    if (cwd) return cwd;
  }
  return undefined;
};

type UseEventRowsOptions = {
  messages: MessageRecord[];
  maxItems?: number;
};

type UseEventRowsResult = {
  rows: EventRowViewModel[];
};

const isImageOnlyInlineRow = (row: AssistantRowViewModel): boolean =>
  row.text.trim().length === 0 &&
  (row.inlineImagePayloads?.length ?? 0) > 0 &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !row.sourceDiffPayloads?.length &&
  !row.selfModApplied &&
  !row.scheduleReceipt &&
  !row.voiceSession &&
  !row.backgroundWork &&
  !row.customSlot;

/** Merge sequential one-by-one image_gen rows into a single inline strip. */
const coalesceInlineImageRows = (
  rows: EventRowViewModel[],
): EventRowViewModel[] => {
  const out: EventRowViewModel[] = [];
  for (const row of rows) {
    if (row.kind !== "assistant" || !isImageOnlyInlineRow(row)) {
      out.push(row);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev?.kind === "assistant" &&
      prev.replyToUserMessageId === row.replyToUserMessageId &&
      !prev.officePreviewRef &&
      !prev.resourcePayload &&
      !prev.sourceDiffPayloads?.length &&
      !prev.selfModApplied &&
      !prev.scheduleReceipt &&
      !prev.backgroundWork &&
      !prev.customSlot
    ) {
      out[out.length - 1] = {
        ...prev,
        inlineImagePayloads: [
          ...(prev.inlineImagePayloads ?? []),
          ...(row.inlineImagePayloads ?? []),
        ],
      };
      continue;
    }
    out.push(row);
  }
  return out;
};

const isVoiceOnlyRow = (row: AssistantRowViewModel): boolean =>
  !!row.voiceSession &&
  row.text.trim().length === 0 &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !row.inlineImagePayloads?.length &&
  !row.sourceDiffPayloads?.length &&
  !row.selfModApplied &&
  !row.scheduleReceipt &&
  !row.backgroundWork &&
  !row.customSlot;

/**
 * Collapse a run of back-to-back voice-session summary rows (no user
 * message or other assistant content between them) into a single
 * "Talked with Stella" chip whose duration is the sum of the run, rather
 * than stacking one chip per session.
 */
const coalesceVoiceSessionRows = (
  rows: EventRowViewModel[],
): EventRowViewModel[] => {
  const out: EventRowViewModel[] = [];
  for (const row of rows) {
    if (row.kind !== "assistant" || !isVoiceOnlyRow(row)) {
      out.push(row);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev?.kind === "assistant" &&
      isVoiceOnlyRow(prev) &&
      prev.voiceSession &&
      row.voiceSession
    ) {
      out[out.length - 1] = {
        ...prev,
        voiceSession: {
          ...prev.voiceSession,
          durationMs:
            prev.voiceSession.durationMs + row.voiceSession.durationMs,
        },
      };
      continue;
    }
    out.push(row);
  }
  return out;
};

/**
 * Stable React key for an assistant row. Live-streaming overlays and
 * their eventual persisted counterparts share this key (both anchor
 * on `(userMessageId, indexInTurn)`). While the live overlay is still
 * present it masks the persisted twin; once the overlay is cleared,
 * the persisted row reuses the same key. Preserves the slot's
 * measured size and Streamdown's parse cache across the handoff.
 *
 * Falls back to `message._id` for assistant messages without a
 * `userMessageId` payload field (rare — e.g. legacy rows or hidden
 * runs that surface without a user-message anchor).
 */
/**
 * Stable cache key for a synthetic trailing artifact row (fire-and-
 * forget image emitted before any assistant text). Prefers the latest
 * `requestId` in the segment so a follow-up tool result for the same
 * request reuses the cached row.
 */
const stableToolSegmentKey = (events: readonly EventRecord[]): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (typeof event.requestId === "string" && event.requestId.trim()) {
      return event.requestId.trim();
    }
  }
  const last = events[events.length - 1];
  return last?._id ?? "trailing";
};

export function useEventRows(opts: UseEventRowsOptions): UseEventRowsResult {
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const { messages, maxItems } = opts;

  const displayMessages = useMemo(
    () => filterMessagesForUiDisplay(messages),
    [messages],
  );

  /**
   * Latest `agent-completed` timestamp per background thread anywhere in the
   * loaded window. Scanned over the raw (unfiltered) messages since the
   * completion event attaches to a later turn's assistant message. This is
   * the reload-safe "done" signal for the inline background-work card —
   * `agent-failed` / `agent-canceled` are not in the message stream, so
   * those terminal states come from live task state at render time.
   *
   * Stored as a timestamp (not a bare set) so a card can scope completion to
   * its OWN run: a thread reused via `send_input` after a prior completion
   * would otherwise inherit that old `agent-completed` and look done. A card
   * only counts a completion at or after its spawn (see `buildBackgroundWork`).
   */
  const completedAtMsById = useMemo(() => {
    const completedAt = new Map<string, number>();
    for (const message of messages) {
      for (const toolEvent of message.toolEvents) {
        if (toolEvent.type !== "agent-completed") continue;
        const agentId = (toolEvent.payload as { agentId?: unknown } | undefined)
          ?.agentId;
        if (typeof agentId === "string" && agentId.length > 0) {
          const prev = completedAt.get(agentId) ?? 0;
          if (toolEvent.timestamp > prev) {
            completedAt.set(agentId, toolEvent.timestamp);
          }
        }
      }
    }
    return completedAt;
  }, [messages]);

  const responseTargetByAssistantId = useMemo(() => {
    const map = new Map<string, AgentResponseTarget | undefined>();
    for (const message of messages) {
      if (!isAssistantMessage(message)) continue;
      const metadata = (
        getMessagePayload(message)?.metadata as
          | { runtime?: { responseTarget?: AgentResponseTarget } }
          | undefined
      )?.runtime;
      map.set(message._id, metadata?.responseTarget);
    }
    return map;
  }, [messages]);

  const allRows = useMemo<EventRowViewModel[]>(() => {
    const computed: EventRowViewModel[] = [];
    /**
     * 1-based per-`userMessageId` count of assistant rows seen so far
     * in this projection walk. Drives `assistantScrollFollowKey(...)`
     * so a live-streaming overlay and the eventual persisted row at
     * the same position end up with the same React key. The display-
     * messages merge upstream filters
     * out overlays whose persisted counterpart has landed, so each
     * `(userMessageId, indexInTurn)` slot is occupied by exactly one
     * source at a time.
     */
    const assistantCountByUserMessageId = new Map<string, number>();

    // Background-work descriptor for a turn's tool events, with the reload-
    // safe completed subset folded in. Shared by the assistant branch and
    // the tool-only (user-anchored) fallback below — a fire-and-forget spawn
    // / send_input that never produced an assistant message lands its tools
    // on the user_message, so it still needs a card.
    const buildBackgroundWork = (toolEvents: readonly EventRecord[]) => {
      const base = getBackgroundWork(toolEvents);
      if (!base) return undefined;
      return {
        ...base,
        // Scope completion to THIS card's run: only count an `agent-completed`
        // at or after the thread's spawn on this turn. A later card for a
        // thread reused via send_input then won't inherit the prior run's
        // completion (the supersede pass freezes earlier cards separately).
        completedThreadIds: base.threadIds.filter((id) => {
          const completedAt = completedAtMsById.get(id);
          return (
            completedAt !== undefined && completedAt >= base.spawnedAtMs[id]
          );
        }),
      };
    };

    for (const message of displayMessages) {
      if (isUserMessage(message)) {
        const contextMetadata = getMessagePayload(message)?.metadata?.context;
        const windowLabel =
          typeof contextMetadata?.windowLabel === "string" &&
          contextMetadata.windowLabel.trim()
            ? contextMetadata.windowLabel.trim()
            : undefined;
        const windowPreviewImageUrl =
          typeof contextMetadata?.windowPreviewImageUrl === "string" &&
          contextMetadata.windowPreviewImageUrl.trim()
            ? contextMetadata.windowPreviewImageUrl.trim()
            : undefined;
        const appSelectionLabel =
          typeof contextMetadata?.appSelectionLabel === "string" &&
          contextMetadata.appSelectionLabel.trim()
            ? contextMetadata.appSelectionLabel.trim()
            : undefined;
        const activityLabel =
          typeof contextMetadata?.activityLabel === "string" &&
          contextMetadata.activityLabel.trim()
            ? contextMetadata.activityLabel.trim()
            : undefined;
        const pastedTexts =
          Array.isArray(contextMetadata?.pastedTexts) &&
          contextMetadata.pastedTexts.length > 0
            ? contextMetadata.pastedTexts
            : undefined;
        const row: UserRowViewModel = {
          kind: "user",
          id: message._id,
          text: getDisplayUserText(message),
          ...(windowLabel ? { windowLabel } : {}),
          ...(windowPreviewImageUrl ? { windowPreviewImageUrl } : {}),
          ...(appSelectionLabel ? { appSelectionLabel } : {}),
          ...(activityLabel ? { activityLabel } : {}),
          ...(pastedTexts ? { pastedTexts } : {}),
          attachments: getAttachments(message),
          ...(getChannelEnvelope(message)
            ? { channelEnvelope: getChannelEnvelope(message) }
            : {}),
        };
        computed.push(row);
        // A fire-and-forget spawn / send_input that never produced an
        // assistant message has its tools anchored on this user_message.
        // Surface the card on a synthetic assistant row right under it so
        // background work is still visible (the working indicator steps
        // aside once a task is running).
        const userBackgroundWork = buildBackgroundWork(message.toolEvents);
        if (userBackgroundWork) {
          const bgKey = `assistant-bgwork-${message._id}`;
          computed.push({
            kind: "assistant",
            id: bgKey,
            text: "",
            cacheKey: bgKey,
            replyToUserMessageId: message._id,
            backgroundWork: userBackgroundWork,
          });
        }
        continue;
      }

      if (isAssistantMessage(message)) {
        const text = getDisplayMessageText(message);
        const payload = getMessagePayload(message);
        const replyToUserMessageId =
          typeof payload?.userMessageId === "string" &&
          payload.userMessageId.length > 0
            ? payload.userMessageId
            : undefined;
        const responseTarget = responseTargetByAssistantId.get(message._id);
        const runtimeMetadata = (
          payload?.metadata as
            | { runtime?: { isStreaming?: boolean } }
            | undefined
        )?.runtime;
        // Unified key for both live-streaming overlays (synthetic
        // `_id`s) and the eventual persisted rows for the same
        // `(userMessageId, indexInTurn)` slot. The display merge
        // ensures only one source is present at a time, so the count
        // stays consistent.
        let stableKey: string;
        if (replyToUserMessageId !== undefined) {
          const indexWithinTurn =
            (assistantCountByUserMessageId.get(replyToUserMessageId) ?? 0) + 1;
          assistantCountByUserMessageId.set(
            replyToUserMessageId,
            indexWithinTurn,
          );
          stableKey = assistantScrollFollowKey(
            replyToUserMessageId,
            indexWithinTurn,
          );
        } else {
          stableKey = message._id;
        }
        const toolEvents = message.toolEvents;
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        );
        const inlineImagePayloads = deriveTurnInlineImagePayloads(toolEvents);
        const webSearchResults = deriveTurnWebSearchResults(toolEvents);
        const sourceDiffPayloads = collectTurnSourceDiffPayloads(toolEvents, {
          developerResourcesEnabled: developerResourcePreviewsEnabled,
        });
        const selfModApplied = payload?.selfModApplied;
        const officePreviewRef = getOfficePreviewRef(toolEvents);
        const voiceSession = payload?.metadata?.voiceSession;
        const backgroundWork = buildBackgroundWork(toolEvents);
        const isStreamingOverlay =
          message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX) &&
          runtimeMetadata?.isStreaming !== false;
        const row: AssistantRowViewModel = {
          kind: "assistant",
          id: stableKey,
          // The voice-session summary card replaces the text body entirely,
          // so the raw "Voice session\n\nDuration: …" model-history fallback
          // never renders as markdown.
          text: voiceSession ? "" : text,
          cacheKey: stableKey,
          ...(isStreamingOverlay ? { isStreaming: true } : {}),
          ...(responseTarget ? { responseTarget } : {}),
          ...(replyToUserMessageId ? { replyToUserMessageId } : {}),
          ...(officePreviewRef ? { officePreviewRef } : {}),
          ...(resourcePayload ? { resourcePayload } : {}),
          ...(inlineImagePayloads.length > 0 ? { inlineImagePayloads } : {}),
          ...(webSearchResults.length > 0 ? { webSearchResults } : {}),
          ...(sourceDiffPayloads.length > 0 ? { sourceDiffPayloads } : {}),
          ...(selfModApplied ? { selfModApplied } : {}),
          ...(getScheduleReceipt(toolEvents)
            ? { scheduleReceipt: getScheduleReceipt(toolEvents) }
            : {}),
          ...(voiceSession ? { voiceSession } : {}),
          ...(backgroundWork ? { backgroundWork } : {}),
        };
        computed.push(row);
      }
    }

    // Trailing artifact card: if the latest message in the loaded window
    // is a `user_message` carrying inline-image tool events (fire-and-
    // forget image submission with no assistant reply yet), surface them
    // as a synthetic assistant row right under the user message. Matches
    // the prior `segmentToolEventsByAssistant`-`trailing` behavior under
    // the new "each message owns the tools that follow it" shape.
    const lastDisplayMessage = displayMessages[displayMessages.length - 1];
    if (lastDisplayMessage && isUserMessage(lastDisplayMessage)) {
      const trailingTools = lastDisplayMessage.toolEvents;
      const trailingInlineImagePayloads =
        deriveTurnInlineImagePayloads(trailingTools);
      if (trailingInlineImagePayloads.length > 0) {
        const stableKey = `assistant-tool-resource-${stableToolSegmentKey(
          trailingTools,
        )}`;
        computed.push({
          kind: "assistant",
          id: stableKey,
          text: "",
          cacheKey: stableKey,
          replyToUserMessageId: lastDisplayMessage._id,
          inlineImagePayloads: trailingInlineImagePayloads,
        });
      }
    }

    // Only the latest card per thread stays live. When a later turn spawns
    // or updates (send_input) the same thread, earlier cards for it are
    // marked superseded so they freeze as settled instead of re-animating
    // (BackgroundWorkCard treats superseded threads as done).
    const latestOwnerByThread = new Map<string, number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      for (const id of row.backgroundWork.threadIds) {
        latestOwnerByThread.set(id, index);
      }
    });
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      const superseded = row.backgroundWork.threadIds.filter(
        (id) => latestOwnerByThread.get(id) !== index,
      );
      if (superseded.length > 0) {
        row.backgroundWork = {
          ...row.backgroundWork,
          supersededThreadIds: superseded,
        };
      }
    });

    return coalesceVoiceSessionRows(coalesceInlineImageRows(computed));
  }, [
    completedAtMsById,
    developerResourcePreviewsEnabled,
    displayMessages,
    responseTargetByAssistantId,
  ]);

  const rowsStableRef = useRef<StableTurnRowsState<EventRowViewModel> | null>(
    null,
  );

  const stableRowsState = useMemo(
    () => stabilizeTurnRows(allRows, rowsStableRef.current, eventRowEqual),
    [allRows],
  );

  useLayoutEffect(() => {
    rowsStableRef.current = stableRowsState;
  }, [stableRowsState]);

  const stableRows = stableRowsState.result;

  const slicedRows = useMemo(() => {
    if (typeof maxItems !== "number") return stableRows;
    const cap = Math.max(0, Math.floor(maxItems));
    if (cap <= 0) return [];
    if (stableRows.length <= cap) return stableRows;
    return stableRows.slice(stableRows.length - cap);
  }, [maxItems, stableRows]);

  return {
    rows: slicedRows,
  };
}
