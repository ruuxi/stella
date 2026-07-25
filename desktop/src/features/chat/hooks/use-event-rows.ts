import { useLayoutEffect, useMemo, useRef } from "react";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MessagePayload } from "@/features/chat/lib/event-transforms";
import {
  isAgentCompletedEvent,
  isAgentStartedEvent,
  isAssistantMessage,
  isUserMessage,
} from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";
import {
  AGENT_IDS,
  isOrchestratorReservedBuiltinAgentId,
} from "../../../../../runtime/contracts/agent-runtime.js";
import { isOfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import type { ScheduleToolAffectedRef } from "../../../../../runtime/kernel/shared/scheduling";
import { pickScheduleToolSummary } from "@/global/schedule/schedule-receipt-summary";
import {
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
} from "@/features/chat/lib/derive-turn-resource";
import {
  buildBackgroundTaskLifecycleIndex,
  followUpReplacesActivePredecessor,
  resolveBackgroundTaskCardLifecycle,
  type BackgroundTaskLifecycleIndex,
} from "@/features/chat/lib/background-task-lifecycle";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { deriveTurnWebSearchResults } from "@/features/chat/lib/derive-turn-web-search";
import { deriveTurnMapArtifacts } from "@/features/chat/lib/derive-turn-map-artifacts";
import { deriveToolActivity } from "@/features/chat/lib/tool-activity";
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
    const summary = pickScheduleToolSummary(payload);
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
 * a failed spawn (so no phantom card).
 *
 * Only user-facing *delegated* work earns a card: `general`, the dedicated
 * `manager` spawned by `spawn_manager`, and any custom user-installed
 * subagent. Manager is the one intentional exception to the reserved-builtin
 * denylist: unlike schedule/fashion/explore/dream/chronicle/install_update,
 * it is a durable background thread created directly by the orchestrator and
 * resumed through `send_input`. A denylist (rather than an allowlist of only
 * known agent types) means legitimate custom subagents still surface while
 * future internal builtins remain excluded automatically. Tool-internal
 * one-shot helpers like HTML/canvas and Recall never emit `agent-started`, so
 * they cannot produce a card regardless.
 */
export const getBackgroundWork = (
  events: readonly EventRecord[],
):
  | {
      threadIds: string[];
      descriptions: Record<string, string>;
      spawnedAtMs: Record<string, number>;
      /** Per-thread follow-up message/description for threads re-activated via
       *  `send_input` on this turn (the card title for a follow-up), lifted
       *  from the `agent-started` `statusText`. Absent for plain spawns. */
      statusTexts: Record<string, string>;
      /** Threads on this card whose `agent-started` was flagged a `send_input`
       *  follow-up (re-activation) rather than a fresh spawn — the explicit
       *  discriminator the card reads to pick its follow-up variant. */
      followUpThreadIds: string[];
      /** Canonical identity/anchor for each task occurrence. Unlike agentId
       *  and rootRunId, this changes for every `send_input` activation. */
      startEventIdsByThread: Record<string, string>;
      attemptGenerationsByThread: Record<string, number>;
      rootRunIdsByThread: Record<string, string>;
      cardId: string;
    }
  | undefined => {
  const threadIds: string[] = [];
  const descriptions: Record<string, string> = {};
  const statusTexts: Record<string, string> = {};
  const followUpThreadIds: string[] = [];
  const startEventIdsByThread: Record<string, string> = {};
  const attemptGenerationsByThread: Record<string, number> = {};
  const rootRunIdsByThread: Record<string, string> = {};
  // When this thread was kicked off / last advanced on this turn (ms). Lets
  // the card distinguish a fresh spawn (read as working) from one whose
  // lifecycle aged out of the loaded windows (presume settled, not pinned
  // as forever-working).
  const spawnedAtMs: Record<string, number> = {};
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;
    // Skip internal/system agents invoked behind a tool (schedule, etc.). A
    // manager is reserved from direct `spawn_agent` targeting, but is still
    // user-visible delegated work when created through `spawn_manager`.
    const agentType = asNonEmptyString(event.payload.agentType);
    if (
      agentType &&
      agentType !== AGENT_IDS.MANAGER &&
      isOrchestratorReservedBuiltinAgentId(agentType)
    ) {
      continue;
    }
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    if (!threadIds.includes(agentId)) threadIds.push(agentId);
    const description = asNonEmptyString(event.payload.description);
    const priorTimestamp = spawnedAtMs[agentId];
    const priorEventId = startEventIdsByThread[agentId];
    const candidateAttempt =
      typeof event.payload.attemptGeneration === "number" &&
      Number.isInteger(event.payload.attemptGeneration) &&
      event.payload.attemptGeneration >= 0
        ? event.payload.attemptGeneration
        : undefined;
    const priorAttempt = attemptGenerationsByThread[agentId];
    const isLatestOccurrence =
      priorTimestamp === undefined ||
      event.timestamp > priorTimestamp ||
      (event.timestamp === priorTimestamp &&
        (candidateAttempt !== undefined || priorAttempt !== undefined
          ? candidateAttempt !== undefined &&
            (priorAttempt === undefined || candidateAttempt > priorAttempt)
          : !priorEventId || event._id.localeCompare(priorEventId) > 0));
    if (isLatestOccurrence) {
      spawnedAtMs[agentId] = event.timestamp;
      startEventIdsByThread[agentId] = event._id;
      if (candidateAttempt !== undefined) {
        attemptGenerationsByThread[agentId] = candidateAttempt;
      } else {
        delete attemptGenerationsByThread[agentId];
      }
      if (description) descriptions[agentId] = description;
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      if (rootRunId) rootRunIdsByThread[agentId] = rootRunId;
      else delete rootRunIdsByThread[agentId];
      const previousFollowUpIndex = followUpThreadIds.indexOf(agentId);
      if (previousFollowUpIndex >= 0) {
        followUpThreadIds.splice(previousFollowUpIndex, 1);
      }
      delete statusTexts[agentId];
      // Explicit runtime signal: a `send_input` re-activation stamps
      // `isFollowUp`; statusText is that occurrence's own title.
      if (event.payload.isFollowUp) {
        followUpThreadIds.push(agentId);
        const followUp = asNonEmptyString(event.payload.statusText);
        if (followUp) statusTexts[agentId] = followUp;
      }
    }
  }
  if (threadIds.length === 0) return undefined;
  const startEventIds = threadIds
    .map((threadId) => startEventIdsByThread[threadId])
    .filter((eventId): eventId is string => Boolean(eventId));
  return {
    threadIds,
    descriptions,
    spawnedAtMs,
    statusTexts,
    followUpThreadIds,
    startEventIdsByThread,
    attemptGenerationsByThread,
    rootRunIdsByThread,
    cardId: `agent-activity:${startEventIds.join("+")}`,
  };
};

/**
 * Preserve one inline receipt per lifecycle start occurrence. A spawn and a
 * `send_input` follow-up can share the same assistant row, but they are still
 * separate user-visible actions and must not be flattened into one card.
 */
export const getBackgroundWorks = (
  events: readonly EventRecord[],
): NonNullable<ReturnType<typeof getBackgroundWork>>[] => {
  const cards: NonNullable<ReturnType<typeof getBackgroundWork>>[] = [];
  // Lifecycle routing can merge an older start into a row that already owns a
  // newer follow-up. The event timestamps/ids are the persisted timeline
  // order; the merged array's insertion order is not.
  const starts = events
    .filter(isAgentStartedEvent)
    .sort((a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id));
  for (const event of starts) {
    const card = getBackgroundWork([event]);
    if (card) cards.push(card);
  }
  return cards;
};

/**
 * Run-scoped "paused" subset for a background-work card: threads whose
 * latest `agent-canceled` (a) postdates this card's spawn and (b) is not
 * outdated by a completion. The orchestrator's pause_agent lands as an
 * agent-canceled lifecycle event and the runtime's thread live-state
 * (`deriveRuntimeThreadLiveState`) reads any non-running thread as
 * paused/resumable, so this is the reload-safe mirror of that signal for
 * the inline card. A resume emits a fresh `agent-started` whose newer card
 * supersedes the paused one.
 */
export const derivePausedThreadIds = (
  threadIds: readonly string[],
  spawnedAtMs: Record<string, number>,
  completedAtMsById: ReadonlyMap<string, number>,
  canceledAtMsById: ReadonlyMap<string, number>,
): string[] =>
  threadIds.filter((id) => {
    const canceledAt = canceledAtMsById.get(id);
    const spawnedAt = spawnedAtMs[id];
    if (
      canceledAt === undefined ||
      spawnedAt === undefined ||
      canceledAt < spawnedAt
    ) {
      return false;
    }
    const completedAt = completedAtMsById.get(id);
    return completedAt === undefined || canceledAt > completedAt;
  });

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

/**
 * Whether an assistant row carries anything other than a background-work
 * receipt. Used by the dedup pass below to decide between clearing just the
 * card (the row has other content to keep) and dropping the synthetic
 * card-only row entirely.
 *
 * Keep in sync with `AssistantRowViewModel` content fields: every renderable
 * field other than `backgroundWork` must be checked here, otherwise a row
 * that carries only that (unchecked) content can be silently dropped when its
 * duplicate background card is deduped.
 */
export const assistantRowHasNonBackgroundContent = (
  row: AssistantRowViewModel,
): boolean =>
  row.text.trim().length > 0 ||
  Boolean(row.isStreaming) ||
  Boolean(row.officePreviewRef) ||
  Boolean(row.resourcePayload) ||
  (row.inlineImagePayloads?.length ?? 0) > 0 ||
  (row.webSearchResults?.length ?? 0) > 0 ||
  (row.mapArtifacts?.length ?? 0) > 0 ||
  (row.sourceDiffPayloads?.length ?? 0) > 0 ||
  Boolean(row.selfModApplied) ||
  Boolean(row.scheduleReceipt) ||
  Boolean(row.voiceSession) ||
  Boolean(row.toolActivity) ||
  (row.agentCompletion?.sections.length ?? 0) > 0 ||
  Boolean(row.customSlot);

/**
 * Reconcile a completion that surfaces on more than one row. During the
 * SQLite/stream handoff the same `agent-completed` event can briefly be
 * projected onto both the user-message fallback row and the assistant row,
 * drawing two identical completion cards. Key each section by `agentId` +
 * `completedAtMs`: the same pair on two rows is the same completion (the
 * latest row wins, mirroring the background-work `latestOwnerByThread`
 * duplicated handling); a different `completedAtMs` is a genuine `send_input`
 * re-run's later completion and both stay. Redundant copies strip their
 * duplicated sections and the row is marked dropped when nothing else
 * remains. Mutates `rows` / `droppedRowIndices` in place (same contract as
 * the background-work pass it sits beside).
 */
export const dedupeAgentCompletionRows = (
  rows: EventRowViewModel[],
  droppedRowIndices: Set<number>,
): void => {
  const completionKey = (section: AgentCompletionSection) =>
    section.completionEventId ??
    `${section.agentId}\u001f${section.completedAtMs}`;
  const latestCompletionOwner = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    for (const section of row.agentCompletion.sections) {
      latestCompletionOwner.set(completionKey(section), index);
    }
  });
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    const surviving = row.agentCompletion.sections.filter(
      (section) => latestCompletionOwner.get(completionKey(section)) === index,
    );
    if (surviving.length === row.agentCompletion.sections.length) return;
    if (surviving.length > 0) {
      row.agentCompletion = { sections: surviving };
      return;
    }
    const { agentCompletion: _omitCompletion, ...rest } = row;
    if (assistantRowHasNonBackgroundContent(rest) || rest.backgroundWork) {
      rows[index] = rest;
    } else {
      // Synthetic row whose sole content was the duplicated completion —
      // drop it so the canonical copy is the only render.
      droppedRowIndices.add(index);
    }
  });
};

/** Resolve completion events on one timeline row through their exact start. */
export const projectAgentCompletionSections = (
  toolEvents: readonly EventRecord[],
  lifecycleIndex: BackgroundTaskLifecycleIndex,
  agentId?: string,
): AgentCompletionSection[] => {
  const sections = new Map<string, AgentCompletionSection>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const startEventId = lifecycleIndex.startEventIdByLifecycleEventId.get(
      event._id,
    );
    const section = startEventId
      ? lifecycleIndex.byStartEventId.get(startEventId)?.completion
      : undefined;
    if (!section) continue;
    if (agentId !== undefined && section.agentId !== agentId) continue;
    sections.set(section.completionEventId ?? event._id, section);
  }
  return [...sections.values()];
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
  !row.agentCompletion?.sections.length &&
  !row.toolActivity &&
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
      !prev.agentCompletion?.sections.length &&
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
  !row.agentCompletion?.sections.length &&
  !row.toolActivity &&
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

export function useEventRows(opts: UseEventRowsOptions): UseEventRowsResult {
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const { messages, maxItems } = opts;

  const displayMessages = useMemo(
    () => filterMessagesForUiDisplay(messages),
    [messages],
  );

  /**
   * Canonical per-start lifecycle state across the loaded transcript. The
   * selector deduplicates live + persisted copies by raw event id and binds a
   * terminal packet to its exact `agent-started` occurrence. That start id is
   * both identity and anchor, so completion can only update the existing card.
   */
  const lifecycleCacheRef = useRef<{
    toolEventsByIndex: ReadonlyArray<readonly EventRecord[]>;
    result: BackgroundTaskLifecycleIndex;
  } | null>(null);
  const lifecycleIndex = useMemo<BackgroundTaskLifecycleIndex>(() => {
    const cache = lifecycleCacheRef.current;
    if (
      cache &&
      cache.toolEventsByIndex.length === messages.length &&
      messages.every((message, index) => {
        const prior = cache.toolEventsByIndex[index];
        return (
          prior === message.toolEvents ||
          (prior?.length === 0 && message.toolEvents.length === 0)
        );
      })
    ) {
      return cache.result;
    }
    const events: EventRecord[] = [];
    const toolEventsByIndex: Array<readonly EventRecord[]> = [];
    for (const message of messages) {
      toolEventsByIndex.push(message.toolEvents);
      for (const event of message.toolEvents) events.push(event);
    }
    const result = buildBackgroundTaskLifecycleIndex(events);
    lifecycleCacheRef.current = { toolEventsByIndex, result };
    return result;
  }, [messages]);

  /**
   * Per-message projection cache. Finalized messages keep a stable object
   * identity across stream deltas (see `stabilizeMessageList`), so their
   * already-projected rows are reused instead of being re-derived on every
   * streamed delta — only the live overlay (whose identity changes per
   * delta) re-projects. Without this the whole list re-derives each frame,
   * O(messages) work that grows with conversation length.
   *
   * Excluded from the cache: rows carrying a background-work card. Those are
   * mutated in place by the dedup/supersede pass below and their
   * `completedThreadIds` depend on the per-frame completion map, so they are
   * rebuilt every frame (they are rare — only turns that spawned agents).
   *
   * Keyed by message identity and invalidated wholesale when the
   * developer-resource-preview flag flips (the only non-message-intrinsic
   * input to a row's content; the per-frame completion map only feeds the
   * uncached background-work rows).
   */
  const projectionCacheRef = useRef<{
    devFlag: boolean;
    byMessage: WeakMap<
      MessageRecord,
      { rows: EventRowViewModel[]; indexWithinTurn: number }
    >;
  }>({
    devFlag: developerResourcePreviewsEnabled,
    byMessage: new WeakMap(),
  });

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

    // Spawn-anchored card descriptor. Terminal/progress payloads may live on a
    // much later message, but the lifecycle selector resolves them back to the
    // exact persisted start event represented by this card.
    const buildBackgroundWorks = (toolEvents: readonly EventRecord[]) =>
      getBackgroundWorks(toolEvents).map((base) => ({
        ...base,
        ...resolveBackgroundTaskCardLifecycle(
          base.threadIds,
          base.startEventIdsByThread,
          lifecycleIndex,
        ),
      }));

    const pushAdditionalBackgroundWorkRows = (
      produced: EventRowViewModel[],
      works: ReturnType<typeof buildBackgroundWorks>,
      baseId: string,
      replyToUserMessageId?: string,
    ) => {
      for (let index = 1; index < works.length; index += 1) {
        const backgroundWork = works[index];
        if (!backgroundWork) continue;
        const id = `${baseId}:agent-activity:${backgroundWork.cardId}`;
        produced.push({
          kind: "assistant",
          id,
          text: "",
          cacheKey: id,
          ...(replyToUserMessageId ? { replyToUserMessageId } : {}),
          backgroundWork,
        });
      }
    };

    const projectionCache = projectionCacheRef.current;
    if (projectionCache.devFlag !== developerResourcePreviewsEnabled) {
      projectionCache.devFlag = developerResourcePreviewsEnabled;
      projectionCache.byMessage = new WeakMap();
    }
    const cacheByMessage = projectionCache.byMessage;

    for (const message of displayMessages) {
      // Advance the per-turn assistant index for every assistant message
      // (cache hit or miss) so the sequential stableKeys stay correct, then
      // reuse the prior projection of any message whose identity — and index
      // position — is unchanged. The live overlay's identity changes per
      // delta, so it always re-projects; finalized rows are reused.
      let indexWithinTurn = -1;
      let assistantReplyId: string | undefined;
      if (isAssistantMessage(message)) {
        const indexPayload = getMessagePayload(message);
        assistantReplyId =
          typeof indexPayload?.userMessageId === "string" &&
          indexPayload.userMessageId.length > 0
            ? indexPayload.userMessageId
            : undefined;
        if (assistantReplyId !== undefined) {
          indexWithinTurn =
            (assistantCountByUserMessageId.get(assistantReplyId) ?? 0) + 1;
          assistantCountByUserMessageId.set(assistantReplyId, indexWithinTurn);
        }
      }

      const cachedProjection = cacheByMessage.get(message);
      if (
        cachedProjection &&
        cachedProjection.indexWithinTurn === indexWithinTurn
      ) {
        for (const cachedRow of cachedProjection.rows) computed.push(cachedRow);
        continue;
      }

      const produced: EventRowViewModel[] = [];

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
        produced.push(row);
        // A fire-and-forget spawn / send_input that never produced an
        // assistant message has its tools anchored on this user_message.
        // Surface the card on a synthetic assistant row right under it so
        // background work is still visible (the working indicator steps
        // aside once a task is running).
        const userBackgroundWorks = buildBackgroundWorks(message.toolEvents);
        const userBackgroundWork = userBackgroundWorks[0];
        if (userBackgroundWork) {
          const activityKey = `assistant-agent-activity-${message._id}`;
          produced.push({
            kind: "assistant",
            id: activityKey,
            text: "",
            cacheKey: activityKey,
            replyToUserMessageId: message._id,
            backgroundWork: userBackgroundWork,
          });
          pushAdditionalBackgroundWorkRows(
            produced,
            userBackgroundWorks,
            activityKey,
            message._id,
          );
        }
      } else if (isAssistantMessage(message)) {
        const text = getDisplayMessageText(message);
        const payload = getMessagePayload(message);
        const replyToUserMessageId = assistantReplyId;
        // Read `responseTarget` straight off this message's own runtime
        // metadata. It was previously precomputed into a per-render
        // `Map<_id, responseTarget>` and looked up here by `message._id` — but
        // that lookup is always THIS same message, so the map was a redundant
        // O(messages) pass + allocation on every streamed delta. Inlining it
        // (it folds into the per-message projection cache for finalized rows;
        // only the live overlay reads it fresh) removes that whole pass.
        const runtimeMetadata = (
          payload?.metadata as
            | {
                runtime?: {
                  isStreaming?: boolean;
                  responseTarget?: AgentResponseTarget;
                };
              }
            | undefined
        )?.runtime;
        const responseTarget = runtimeMetadata?.responseTarget;
        // Unified key for both live-streaming overlays (synthetic
        // `_id`s) and the eventual persisted rows for the same
        // `(userMessageId, indexInTurn)` slot. The display merge
        // ensures only one source is present at a time, so the count
        // stays consistent. `indexWithinTurn` was advanced in the loop
        // preamble (so cache hits keep positions correct).
        const stableKey =
          replyToUserMessageId !== undefined
            ? assistantScrollFollowKey(replyToUserMessageId, indexWithinTurn)
            : message._id;
        const toolEvents = message.toolEvents;
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        );
        const inlineImagePayloads = deriveTurnInlineImagePayloads(toolEvents);
        const webSearchResults = deriveTurnWebSearchResults(toolEvents);
        const mapArtifacts = deriveTurnMapArtifacts(toolEvents);
        const sourceDiffPayloads = collectTurnSourceDiffPayloads(toolEvents, {
          developerResourcesEnabled: developerResourcePreviewsEnabled,
        });
        const selfModApplied = payload?.selfModApplied;
        const scheduleReceipt = getScheduleReceipt(toolEvents);
        const officePreviewRef = getOfficePreviewRef(toolEvents);
        const voiceSession = payload?.metadata?.voiceSession;
        const backgroundWorks = buildBackgroundWorks(toolEvents);
        const backgroundWork = backgroundWorks[0];
        const agentCompletionSections = projectAgentCompletionSections(
          toolEvents,
          lifecycleIndex,
        );
        const toolActivity = deriveToolActivity(toolEvents);
        const isStreamingOverlay =
          message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX) &&
          runtimeMetadata?.isStreaming !== false;
        // Inline artifact cards (generated images, html/canvas + tool-output
        // resource previews, office files, source diffs, the web-search image
        // strip, and the tool-activity trace) only render once their owning
        // assistant message is finalized — never on the live in-progress
        // overlay row while the turn is still streaming / thinking / running
        // tools. The same tool events resurface on the persisted (terminal)
        // row once the overlay locks or clears, so the cards appear there.
        // Non-artifact receipts (voice-session summary, schedule receipt,
        // self-mod notice, background-work card) keep rendering live.
        const showInlineArtifacts = !isStreamingOverlay;
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
          ...(showInlineArtifacts && officePreviewRef
            ? { officePreviewRef }
            : {}),
          ...(showInlineArtifacts && resourcePayload
            ? { resourcePayload }
            : {}),
          ...(showInlineArtifacts && inlineImagePayloads.length > 0
            ? { inlineImagePayloads }
            : {}),
          ...(showInlineArtifacts && webSearchResults.length > 0
            ? { webSearchResults }
            : {}),
          ...(showInlineArtifacts && mapArtifacts.length > 0
            ? { mapArtifacts }
            : {}),
          ...(showInlineArtifacts && sourceDiffPayloads.length > 0
            ? { sourceDiffPayloads }
            : {}),
          ...(selfModApplied ? { selfModApplied } : {}),
          ...(scheduleReceipt ? { scheduleReceipt } : {}),
          ...(voiceSession ? { voiceSession } : {}),
          ...(backgroundWork ? { backgroundWork } : {}),
          ...(agentCompletionSections.length > 0
            ? { agentCompletion: { sections: agentCompletionSections } }
            : {}),
          ...(showInlineArtifacts && toolActivity ? { toolActivity } : {}),
        };
        produced.push(row);
        pushAdditionalBackgroundWorkRows(
          produced,
          backgroundWorks,
          stableKey,
          replyToUserMessageId,
        );
      }

      // Cache the projection for reuse on the next delta, EXCEPT rows that
      // carry an agent activity card: those are mutated by the dedup passes
      // below and depend on per-frame cross-row lifecycle state, so they must be rebuilt
      // each frame. Everything else is a pure function of the (stable)
      // message identity + dev flag.
      const hasAgentActivityCard = produced.some(
        (producedRow) =>
          producedRow.kind === "assistant" &&
          (Boolean(producedRow.backgroundWork) ||
            (producedRow.agentCompletion?.sections.length ?? 0) > 0),
      );
      if (hasAgentActivityCard) {
        cacheByMessage.delete(message);
      } else {
        cacheByMessage.set(message, { rows: produced, indexWithinTurn });
      }
      for (const producedRow of produced) computed.push(producedRow);
    }

    // No synthetic trailing artifact row: a `user_message` carrying inline-
    // image tool events with no assistant reply yet is an in-progress turn,
    // and inline artifact cards only render once their owning assistant
    // message is finalized. The images resurface on that assistant row's
    // tool events once it lands (see `showInlineArtifacts` above), so the
    // fire-and-forget stand-in is no longer projected mid-flight.

    // Reconcile a thread that surfaces on more than one row. Exact duplicate
    // copies share the canonical `agent-started` event id. A different start
    // id is a genuine later activation of the durable thread.
    //
    //  - Follow-up while active: the newer card replaces the predecessor.
    //    There is no synthetic completed breadcrumb for the interrupted
    //    occurrence; only the current follow-up remains visible.
    //
    //  - Follow-up after settlement: both cards remain. The predecessor keeps
    //    its real terminal state/prose and the follow-up owns its own status.
    //
    //  - Exact duplicate: the SAME `agent-started` event (identical
    //    `spawnedAtMs`) projected onto two rows — e.g. a fire-and-forget
    //    spawn briefly anchored on both the user-message fallback row and the
    //    assistant row during the SQLite/stream handoff. Rendering both draws
    //    two identical "Started in background" receipts, so the redundant
    //    (non-canonical) copy drops the thread entirely. One spawn = one card.
    const latestOwnerByThread = new Map<string, number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      for (const id of row.backgroundWork.threadIds) {
        latestOwnerByThread.set(id, index);
      }
    });
    const ownerBackgroundWorkForThread = (id: string) => {
      const ownerIndex = latestOwnerByThread.get(id);
      if (ownerIndex === undefined) return undefined;
      const owner = computed[ownerIndex];
      if (owner?.kind !== "assistant" || !owner.backgroundWork)
        return undefined;
      return owner.backgroundWork;
    };
    const droppedRowIndices = new Set<number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      const superseded: string[] = [];
      const duplicated = new Set<string>();
      const replaced = new Set<string>();
      for (const id of row.backgroundWork.threadIds) {
        if (latestOwnerByThread.get(id) === index) continue;
        const owner = ownerBackgroundWorkForThread(id);
        const ownerStartEventId = owner?.startEventIdsByThread[id];
        const selfStartEventId = row.backgroundWork.startEventIdsByThread[id];
        if (
          ownerStartEventId !== undefined &&
          selfStartEventId === ownerStartEventId
        ) {
          duplicated.add(id);
        } else if (
          ownerStartEventId &&
          selfStartEventId &&
          owner?.followUpThreadIds?.includes(id) &&
          followUpReplacesActivePredecessor(
            selfStartEventId,
            ownerStartEventId,
            lifecycleIndex,
          )
        ) {
          replaced.add(id);
        } else if (owner?.followUpThreadIds?.includes(id)) {
          // The predecessor had already settled before this follow-up. Keep
          // its terminal card, but fence it from the durable thread's newer
          // attempt so only the follow-up can become the current live unit.
          superseded.push(id);
        } else {
          superseded.push(id);
        }
      }
      const removed = new Set([...duplicated, ...replaced]);
      if (removed.size === 0) {
        if (superseded.length > 0) {
          row.backgroundWork = {
            ...row.backgroundWork,
            supersededThreadIds: superseded,
          };
        }
        return;
      }
      const remainingThreadIds = row.backgroundWork.threadIds.filter(
        (id) => !removed.has(id),
      );
      if (remainingThreadIds.length === 0) {
        if (assistantRowHasNonBackgroundContent(row)) {
          const { backgroundWork: _omit, ...rest } = row;
          computed[index] = rest;
        } else {
          // Synthetic card-only row whose sole receipt was duplicated or
          // replaced by an in-flight follow-up — keep only the current card.
          droppedRowIndices.add(index);
        }
        return;
      }
      const descriptions = { ...row.backgroundWork.descriptions };
      const spawnedAtMs = { ...(row.backgroundWork.spawnedAtMs ?? {}) };
      const statusTexts = { ...(row.backgroundWork.statusTexts ?? {}) };
      const progressTexts = { ...(row.backgroundWork.progressTexts ?? {}) };
      const toolActivities = { ...(row.backgroundWork.toolActivities ?? {}) };
      const startEventIdsByThread = {
        ...row.backgroundWork.startEventIdsByThread,
      };
      const attemptGenerationsByThread = {
        ...(row.backgroundWork.attemptGenerationsByThread ?? {}),
      };
      const rootRunIdsByThread = { ...row.backgroundWork.rootRunIdsByThread };
      const terminalEventIdsByThread = {
        ...(row.backgroundWork.terminalEventIdsByThread ?? {}),
      };
      for (const id of removed) {
        delete descriptions[id];
        delete spawnedAtMs[id];
        delete statusTexts[id];
        delete progressTexts[id];
        delete toolActivities[id];
        delete startEventIdsByThread[id];
        delete attemptGenerationsByThread[id];
        delete rootRunIdsByThread[id];
        delete terminalEventIdsByThread[id];
      }
      const remainingSuperseded = superseded.filter((id) =>
        remainingThreadIds.includes(id),
      );
      const followUpThreadIds = (
        row.backgroundWork.followUpThreadIds ?? []
      ).filter((id) => !removed.has(id));
      row.backgroundWork = {
        ...row.backgroundWork,
        threadIds: remainingThreadIds,
        completedThreadIds: row.backgroundWork.completedThreadIds.filter(
          (id) => !removed.has(id),
        ),
        ...(row.backgroundWork.pausedThreadIds
          ? {
              pausedThreadIds: row.backgroundWork.pausedThreadIds.filter(
                (id) => !removed.has(id),
              ),
            }
          : {}),
        ...(row.backgroundWork.failedThreadIds
          ? {
              failedThreadIds: row.backgroundWork.failedThreadIds.filter(
                (id) => !removed.has(id),
              ),
            }
          : {}),
        descriptions,
        spawnedAtMs,
        statusTexts,
        progressTexts,
        toolActivities,
        startEventIdsByThread,
        attemptGenerationsByThread,
        rootRunIdsByThread,
        terminalEventIdsByThread,
        completionSections: (
          row.backgroundWork.completionSections ?? []
        ).filter(
          (section) =>
            !section.startEventId ||
            !removed.has(section.agentId) ||
            startEventIdsByThread[section.agentId] === section.startEventId,
        ),
        cardId: `agent-activity:${remainingThreadIds
          .map((id) => startEventIdsByThread[id])
          .filter(Boolean)
          .join("+")}`,
        followUpThreadIds,
        ...(remainingSuperseded.length > 0
          ? { supersededThreadIds: remainingSuperseded }
          : {}),
      };
    });

    dedupeAgentCompletionRows(computed, droppedRowIndices);

    const deduped =
      droppedRowIndices.size > 0
        ? computed.filter((_, index) => !droppedRowIndices.has(index))
        : computed;

    return coalesceVoiceSessionRows(coalesceInlineImageRows(deduped));
  }, [developerResourcePreviewsEnabled, displayMessages, lifecycleIndex]);

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
