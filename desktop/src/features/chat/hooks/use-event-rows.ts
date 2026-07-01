import { useLayoutEffect, useMemo, useRef } from "react";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MessagePayload } from "@/features/chat/lib/event-transforms";
import {
  isAgentStartedEvent,
  isAssistantMessage,
  isUserMessage,
} from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";
import { isOrchestratorReservedBuiltinAgentId } from "../../../../../runtime/contracts/agent-runtime.js";
import { isOfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import type { ScheduleToolAffectedRef } from "../../../../../runtime/kernel/shared/scheduling";
import { pickScheduleToolSummary } from "@/global/schedule/schedule-receipt-summary";
import {
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
} from "@/features/chat/lib/derive-turn-resource";
import {
  buildAgentCompletionSections,
  buildAgentMetaMap,
  type AgentMeta,
} from "@/features/chat/lib/agent-completion";
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
 * a failed spawn (so no phantom card). Multiple in one turn collapse into a
 * single descriptor (one card that tallies them); the optional group label
 * becomes the card's title.
 *
 * Only user-facing *delegated* work earns a card: the `general` agent and
 * any custom user-installed subagent. This applies just the
 * reserved-builtin *denylist* half of `spawn_agent`'s acceptance check, not
 * its full validation — it does not also confirm the agent type is a
 * registered subagent. Orchestrator-reserved builtin agents (schedule,
 * fashion, explore, dream, chronicle, install_update, …) run behind tools
 * as internal/system helpers, so their `agent-started` events are filtered
 * out here via the same `isOrchestratorReservedBuiltinAgentId` predicate
 * that `spawn_agent` uses to reject reserved targets. A denylist (rather
 * than an allowlist of `general`) means legitimate custom subagents the
 * user kicked off still surface, while any future internal builtin is
 * excluded automatically. (Tool-internal one-shot helpers like
 * the HTML/canvas renderer and recall lookup never emit `agent-started`
 * events at all, so they can't produce a card regardless.)
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
      groupKey?: string;
      label?: string;
    }
  | undefined => {
  const threadIds: string[] = [];
  const descriptions: Record<string, string> = {};
  const statusTexts: Record<string, string> = {};
  const followUpThreadIds: string[] = [];
  // When this thread was kicked off / last advanced on this turn (ms). Lets
  // the card distinguish a fresh spawn (read as working) from one whose
  // lifecycle aged out of the loaded windows (presume settled, not pinned
  // as forever-working).
  const spawnedAtMs: Record<string, number> = {};
  let groupKey: string | undefined;
  let label: string | undefined;
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;
    // Skip internal/system agents invoked behind a tool (schedule, etc.):
    // the inline card is only a "started here" receipt for user-facing
    // delegated work. Mirrors `spawn_agent`'s own acceptance rule.
    const agentType = asNonEmptyString(event.payload.agentType);
    if (agentType && isOrchestratorReservedBuiltinAgentId(agentType)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    if (!threadIds.includes(agentId)) threadIds.push(agentId);
    const description = asNonEmptyString(event.payload.description);
    if (description && !descriptions[agentId])
      descriptions[agentId] = description;
    // Explicit runtime signal: a `send_input` re-activation stamps
    // `isFollowUp` (see `LocalAgentManager` `tryStartNext`), so a follow-up
    // whose text is identical to the spawn description still reads as a
    // follow-up. The follow-up's own message rides on `statusText` and
    // becomes the card title.
    if (event.payload.isFollowUp) {
      if (!followUpThreadIds.includes(agentId)) followUpThreadIds.push(agentId);
      const followUp = asNonEmptyString(event.payload.statusText);
      if (followUp && !statusTexts[agentId]) statusTexts[agentId] = followUp;
    }
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
    statusTexts,
    followUpThreadIds,
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
  const completionKey = (agentId: string, completedAtMs: number) =>
    `${agentId}\u001f${completedAtMs}`;
  const latestCompletionOwner = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    for (const section of row.agentCompletion.sections) {
      latestCompletionOwner.set(
        completionKey(section.agentId, section.completedAtMs),
        index,
      );
    }
  });
  rows.forEach((row, index) => {
    if (row.kind !== "assistant" || !row.agentCompletion) return;
    const surviving = row.agentCompletion.sections.filter(
      (section) =>
        latestCompletionOwner.get(
          completionKey(section.agentId, section.completedAtMs),
        ) === index,
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
   * Latest `agent-completed` timestamp per background thread anywhere in the
   * loaded window. Scanned over the raw (unfiltered) messages since the
   * completion event attaches to a later turn's assistant message. This is
   * the reload-safe "done" signal for the inline background-work card. Failed
   * / canceled terminal states are intentionally not counted as completed here;
   * those states come from live task state at render time.
   *
   * Stored as a timestamp (not a bare set) so a card can scope completion to
   * its OWN run: a thread reused via `send_input` after a prior completion
   * would otherwise inherit that old `agent-completed` and look done. A card
   * only counts a completion at or after its spawn (see `buildBackgroundWork`).
   */
  // Incremental build. The bare `useMemo([messages])` re-scanned EVERY
  // message's EVERY tool event on every streamed delta (the `messages` array
  // identity changes each delta as the live overlay grows), i.e.
  // O(messages x toolEvents) per frame — growing with conversation length on
  // the auto-scroll critical path. Two structural facts make this avoidable:
  //
  //   1. `agent-completed` contributions are intrinsic to a message's
  //      `toolEvents` array, and `stabilizeMessageList` keeps each finalized
  //      message's `toolEvents` reference stable across deltas.
  //   2. During pure text streaming no `toolEvents` change at all.
  //
  // So: cache each `toolEvents` array's contribution by reference, and when
  // every message's `toolEvents` ref matches the previous build, return the
  // prior Map untouched (no rebuild, no allocation). When some change, rebuild
  // but reuse cached contributions for unchanged arrays — the heavy
  // agent-completed scan runs only for genuinely new/changed tool-event lists.
  const completedCacheRef = useRef<{
    toolEventsByIndex: Array<EventRecord[] | undefined>;
    contributionByToolEvents: WeakMap<
      EventRecord[],
      ReadonlyArray<readonly [string, number]>
    >;
    result: Map<string, number>;
  } | null>(null);

  const completedAtMsById = useMemo(() => {
    const cache = completedCacheRef.current;
    if (cache && cache.toolEventsByIndex.length === messages.length) {
      let unchanged = true;
      for (let i = 0; i < messages.length; i += 1) {
        if (cache.toolEventsByIndex[i] !== messages[i].toolEvents) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return cache.result;
    }

    const contributionByToolEvents =
      cache?.contributionByToolEvents ??
      new WeakMap<EventRecord[], ReadonlyArray<readonly [string, number]>>();
    const toolEventsByIndex: Array<EventRecord[] | undefined> = new Array(
      messages.length,
    );
    const completedAt = new Map<string, number>();

    for (let i = 0; i < messages.length; i += 1) {
      const toolEvents = messages[i].toolEvents;
      toolEventsByIndex[i] = toolEvents;
      if (!toolEvents || toolEvents.length === 0) continue;

      let contribution = contributionByToolEvents.get(toolEvents);
      if (!contribution) {
        const pairs: Array<readonly [string, number]> = [];
        for (const toolEvent of toolEvents) {
          if (toolEvent.type !== "agent-completed") continue;
          const agentId = (
            toolEvent.payload as { agentId?: unknown } | undefined
          )?.agentId;
          if (typeof agentId === "string" && agentId.length > 0) {
            pairs.push([agentId, toolEvent.timestamp] as const);
          }
        }
        contribution = pairs;
        contributionByToolEvents.set(toolEvents, contribution);
      }

      for (const [agentId, ts] of contribution) {
        if (ts > (completedAt.get(agentId) ?? 0)) completedAt.set(agentId, ts);
      }
    }

    completedCacheRef.current = {
      toolEventsByIndex,
      contributionByToolEvents,
      result: completedAt,
    };
    return completedAt;
  }, [messages]);

  /**
   * Per-agent identity/label metadata, folded from every `agent-started`
   * lifecycle event across the loaded window. The completion card needs this
   * to title each section and to apply the reserved-builtin denylist — the
   * `agent-completed` payload carries neither `description` nor `agentType`,
   * and the spawn may live on an EARLIER row than the completion, so it can't
   * be read from the completing row's own events alone.
   *
   * Same incremental, reference-gated build as `completedAtMsById`: cache each
   * `toolEvents` array's `agent-started` contribution by reference and reuse
   * the prior map whole when no `toolEvents` array changed (the common case
   * during pure text streaming).
   */
  const agentMetaCacheRef = useRef<{
    toolEventsByIndex: Array<EventRecord[] | undefined>;
    contributionByToolEvents: WeakMap<
      EventRecord[],
      ReadonlyArray<readonly [string, AgentMeta]>
    >;
    result: Map<string, AgentMeta>;
  } | null>(null);

  const agentMetaById = useMemo(() => {
    const cache = agentMetaCacheRef.current;
    if (cache && cache.toolEventsByIndex.length === messages.length) {
      let unchanged = true;
      for (let i = 0; i < messages.length; i += 1) {
        if (cache.toolEventsByIndex[i] !== messages[i].toolEvents) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return cache.result;
    }

    const contributionByToolEvents =
      cache?.contributionByToolEvents ??
      new WeakMap<EventRecord[], ReadonlyArray<readonly [string, AgentMeta]>>();
    const toolEventsByIndex: Array<EventRecord[] | undefined> = new Array(
      messages.length,
    );
    const metaById = new Map<string, AgentMeta>();

    for (let i = 0; i < messages.length; i += 1) {
      const toolEvents = messages[i].toolEvents;
      toolEventsByIndex[i] = toolEvents;
      if (!toolEvents || toolEvents.length === 0) continue;

      let contribution = contributionByToolEvents.get(toolEvents);
      if (!contribution) {
        // Same fold as the pure derivation — one implementation, cached per
        // toolEvents array reference.
        contribution = [...buildAgentMetaMap(toolEvents).entries()];
        contributionByToolEvents.set(toolEvents, contribution);
      }

      // First non-empty value per field wins (an earlier richer spawn label
      // isn't clobbered by a later `send_input` re-activation that reuses the
      // original description).
      for (const [agentId, meta] of contribution) {
        const existing = metaById.get(agentId);
        if (!existing) {
          metaById.set(agentId, { ...meta });
          continue;
        }
        if (!existing.description && meta.description) {
          existing.description = meta.description;
        }
        if (!existing.agentType && meta.agentType) {
          existing.agentType = meta.agentType;
        }
        if (!existing.groupLabel && meta.groupLabel) {
          existing.groupLabel = meta.groupLabel;
        }
      }
    }

    agentMetaCacheRef.current = {
      toolEventsByIndex,
      contributionByToolEvents,
      result: metaById,
    };
    return metaById;
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
        const userBackgroundWork = buildBackgroundWork(message.toolEvents);
        const userAgentCompletion = buildAgentCompletionSections(
          message.toolEvents,
          agentMetaById,
        );
        if (userBackgroundWork || userAgentCompletion.length > 0) {
          const activityKey = `assistant-agent-activity-${message._id}`;
          produced.push({
            kind: "assistant",
            id: activityKey,
            text: "",
            cacheKey: activityKey,
            replyToUserMessageId: message._id,
            ...(userBackgroundWork
              ? { backgroundWork: userBackgroundWork }
              : {}),
            ...(userAgentCompletion.length > 0
              ? { agentCompletion: { sections: userAgentCompletion } }
              : {}),
          });
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
        const officePreviewRef = getOfficePreviewRef(toolEvents);
        const voiceSession = payload?.metadata?.voiceSession;
        const backgroundWork = buildBackgroundWork(toolEvents);
        // Delegated-agent completion card: the "done + pills" surface anchored
        // to the row this turn's `agent-completed` events land on (the
        // chronological completion point). Append-only by construction — each
        // completion carries only its run's files on its own row. Deliberately
        // NOT gated on `showInlineArtifacts`: an agent finishing mid-stream
        // should reveal its files at that moment (like the other lifecycle
        // receipts), not wait for the orchestrator's text to finalize.
        const agentCompletionSections = buildAgentCompletionSections(
          toolEvents,
          agentMetaById,
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
          ...(showInlineArtifacts && resourcePayload ? { resourcePayload } : {}),
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
          ...(getScheduleReceipt(toolEvents)
            ? { scheduleReceipt: getScheduleReceipt(toolEvents) }
            : {}),
          ...(voiceSession ? { voiceSession } : {}),
          ...(backgroundWork ? { backgroundWork } : {}),
          ...(agentCompletionSections.length > 0
            ? { agentCompletion: { sections: agentCompletionSections } }
            : {}),
          ...(showInlineArtifacts && toolActivity ? { toolActivity } : {}),
        };
        produced.push(row);
      }

      // Cache the projection for reuse on the next delta, EXCEPT rows that
      // carry a background-work or agent-completion card: those are mutated
      // by the dedup pass below and depend on per-frame cross-row inputs
      // (the completion map / the agent-meta map), so they must be rebuilt
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

    // Reconcile a thread that surfaces on more than one row. Two distinct
    // cases, distinguished by the per-thread `spawnedAtMs` (the source
    // `agent-started` event's timestamp):
    //
    //  - Genuine re-activation: a LATER turn spawns or updates (send_input)
    //    the same thread, carrying a strictly newer `agent-started`. The
    //    later card owns the thread; earlier cards are marked superseded so
    //    they read as settled breadcrumbs instead of re-animating.
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
    const ownerSpawnedAtForThread = (id: string): number | undefined => {
      const ownerIndex = latestOwnerByThread.get(id);
      if (ownerIndex === undefined) return undefined;
      const owner = computed[ownerIndex];
      if (owner?.kind !== "assistant" || !owner.backgroundWork) return undefined;
      return owner.backgroundWork.spawnedAtMs?.[id];
    };
    const droppedRowIndices = new Set<number>();
    computed.forEach((row, index) => {
      if (row.kind !== "assistant" || !row.backgroundWork) return;
      const superseded: string[] = [];
      const duplicated = new Set<string>();
      for (const id of row.backgroundWork.threadIds) {
        if (latestOwnerByThread.get(id) === index) continue;
        const ownerSpawnedAt = ownerSpawnedAtForThread(id);
        const selfSpawnedAt = row.backgroundWork.spawnedAtMs?.[id];
        // A strictly later spawn time means a separate re-activation lives
        // below — freeze this earlier copy. Same (or unknown) time means the
        // same lifecycle event surfaced twice — collapse onto the canonical
        // owner.
        if (
          ownerSpawnedAt !== undefined &&
          selfSpawnedAt !== undefined &&
          ownerSpawnedAt > selfSpawnedAt
        ) {
          superseded.push(id);
        } else {
          duplicated.add(id);
        }
      }
      if (duplicated.size === 0) {
        if (superseded.length > 0) {
          row.backgroundWork = {
            ...row.backgroundWork,
            supersededThreadIds: superseded,
          };
        }
        return;
      }
      const remainingThreadIds = row.backgroundWork.threadIds.filter(
        (id) => !duplicated.has(id),
      );
      if (remainingThreadIds.length === 0) {
        if (assistantRowHasNonBackgroundContent(row)) {
          const { backgroundWork: _omit, ...rest } = row;
          computed[index] = rest;
        } else {
          // Synthetic card-only row whose sole receipt was a duplicate —
          // drop it so the canonical copy is the only render.
          droppedRowIndices.add(index);
        }
        return;
      }
      const descriptions = { ...row.backgroundWork.descriptions };
      const spawnedAtMs = { ...(row.backgroundWork.spawnedAtMs ?? {}) };
      const statusTexts = { ...(row.backgroundWork.statusTexts ?? {}) };
      for (const id of duplicated) {
        delete descriptions[id];
        delete spawnedAtMs[id];
        delete statusTexts[id];
      }
      const remainingSuperseded = superseded.filter((id) =>
        remainingThreadIds.includes(id),
      );
      const followUpThreadIds = (row.backgroundWork.followUpThreadIds ?? []).filter(
        (id) => !duplicated.has(id),
      );
      row.backgroundWork = {
        ...row.backgroundWork,
        threadIds: remainingThreadIds,
        completedThreadIds: row.backgroundWork.completedThreadIds.filter(
          (id) => !duplicated.has(id),
        ),
        descriptions,
        spawnedAtMs,
        statusTexts,
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
  }, [
    agentMetaById,
    completedAtMsById,
    developerResourcePreviewsEnabled,
    displayMessages,
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
