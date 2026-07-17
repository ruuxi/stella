/**
 * Inline "background work" card — the live presentation of a stable,
 * spawn-anchored task occurrence.
 *
 * Marks, in the chat flow itself, the spot where Stella kicked something
 * off in the background. The card records "this task was triggered here" at
 * spawn time and stays put as a historical anchor. Progress/failure update
 * this same surface; a fully completed occurrence switches to the settled
 * `AgentCompletionCard` presentation in the same row. Several pieces of work
 * started in the same turn collapse into this one card (it just tallies
 * them as a count) rather than stacking a card per thread.
 *
 * Two variants share the same surface:
 *   - spawn ("started X" — `spawn_agent` or `spawn_manager` kicked off new
 *     background work)
 *   - follow-up ("update sent to X" — `send_input` advanced an already-
 *     spawned thread). A follow-up reuses the thread's original description,
 *     so the runtime carries the follow-up's own message on `statusText`;
 *     the card surfaces THAT (not the stale spawn description) and reads as a
 *     distinct update breadcrumb. See `getBackgroundWork`.
 *
 * Presence/identity and the captured descriptions come from the spawning
 * turn's tool events (`useEventRows`). The running/settled tell is derived
 * from the reload-safe completion/superseded sets plus a stale-spawn timer
 * (no live task context is needed — the card resolves "still working" from
 * the props threaded through the row).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Check, MessageSquare, Send, X } from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
import type { TaskToolActivity } from "../../../../runtime/contracts/agent-runtime.js";
import { friendlyInlineToolStatus } from "@/app/chat/friendly-tool-status";
import {
  getTaskDecoration,
  subscribeTaskDecoration,
} from "@/features/chat/streaming/task-decoration-store";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import { openAgentThreadTab } from "@/features/workspace-display/open-payload";
import "./background-work-card.css";

/** A thread with no completion signal that was spawned longer ago than this
 *  is presumed settled (its lifecycle aged out of the loaded windows) rather
 *  than pinned as forever-working. Comfortably longer than the spawn →
 *  first-signal latency, so a genuinely fresh spawn still reads as working
 *  until its completion lands. */
const STALE_NO_SIGNAL_MS = 5 * 60_000;

/** Sweep duration for the title shimmer — a touch quicker than the base
 *  TextShimmer so the in-progress state reads as lively. */
const TITLE_SHIMMER_MS = 1900;

/** Whether any thread the card covers is still working, plus the earliest
 *  stale deadline the card should re-evaluate itself on. A thread reads as
 *  working until its `agent-completed` lands (`completedThreadIds`), a later
 *  turn's card takes it over (`supersededThreadIds`), or it ages past the
 *  stale threshold with no completion signal. */
function computeWorking(
  threadIds: string[],
  completedThreadIds: readonly string[],
  pausedThreadIds: readonly string[],
  failedThreadIds: readonly string[],
  supersededThreadIds: readonly string[],
  spawnedAtMs: Record<string, number>,
): { working: boolean; paused: boolean; nextStaleDeadlineMs?: number } {
  const completedSet = new Set(completedThreadIds);
  const pausedSet = new Set(pausedThreadIds);
  const failedSet = new Set(failedThreadIds);
  const supersededSet = new Set(supersededThreadIds);
  const now = Date.now();
  let working = false;
  let paused = false;
  let nextStaleDeadlineMs: number | undefined;

  for (const id of threadIds) {
    // A later turn's card owns this thread's live status now — treat it as
    // settled here so this (earlier) card doesn't shimmer on revival.
    if (supersededSet.has(id)) continue;
    // Its `agent-completed` has landed in the message stream.
    if (completedSet.has(id)) continue;
    if (failedSet.has(id)) continue;
    // Paused (its latest `agent-canceled` postdates this card's spawn):
    // not working — the shimmer stops — but flagged so the card can label
    // itself "Paused" instead of reading as settled.
    if (pausedSet.has(id)) {
      paused = true;
      continue;
    }
    // No completion signal: a fresh spawn reads as working; one whose
    // lifecycle aged out of the loaded windows is presumed settled so the
    // card doesn't shimmer "working" forever after a reload.
    const spawnedAt = spawnedAtMs[id];
    if (spawnedAt && now - spawnedAt > STALE_NO_SIGNAL_MS) continue;
    working = true;
    if (spawnedAt) {
      const deadline = spawnedAt + STALE_NO_SIGNAL_MS;
      if (nextStaleDeadlineMs === undefined || deadline < nextStaleDeadlineMs) {
        nextStaleDeadlineMs = deadline;
      }
    }
  }

  return {
    working,
    paused,
    // Only arm a timer while the card is still shimmering — once settled,
    // crossing a deadline wouldn't change anything.
    ...(working && nextStaleDeadlineMs !== undefined
      ? { nextStaleDeadlineMs }
      : {}),
  };
}

/** Per-thread descriptions in spawn order, from the reload-safe
 *  descriptions captured on the spawning row at spawn time. */
function resolveDescriptions(
  threadIds: string[],
  descriptions: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const id of threadIds) {
    const captured = descriptions[id];
    if (captured) out.push(captured);
  }
  return out;
}

export function BackgroundWorkCard({
  threadIds,
  completedThreadIds,
  pausedThreadIds,
  failedThreadIds,
  supersededThreadIds,
  spawnedAtMs,
  descriptions,
  statusTexts,
  progressTexts,
  toolActivities,
  followUpThreadIds,
  cardId,
  startEventIdsByThread,
  rootRunIdsByThread,
  terminalEventIdsByThread,
  label,
  conversationId,
}: {
  threadIds: string[];
  /** Reload-safe subset whose `agent-completed` event has landed — used to
   *  decide whether the title still shimmers. */
  completedThreadIds?: string[];
  /** Subset paused since this card's spawn (latest `agent-canceled` wins) —
   *  the shimmer stops and the subtitle reads "Paused" until a resume's
   *  fresh `agent-started` supersedes this card. */
  pausedThreadIds?: string[];
  /** Run-scoped failures. These settle the existing card in place. */
  failedThreadIds?: string[];
  /** Subset a later turn's card now owns; frozen as settled here. */
  supersededThreadIds?: string[];
  /** Per-thread spawn/last-advanced time (ms) for the stale-spawn fallback. */
  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;
  /** Per-thread follow-up text for `send_input` re-activations. */
  statusTexts?: Record<string, string>;
  progressTexts?: Record<string, string>;
  toolActivities?: Record<string, TaskToolActivity>;
  /** Threads on this card that are `send_input` follow-ups, not fresh spawns. */
  followUpThreadIds?: string[];
  cardId: string;
  startEventIdsByThread: Record<string, string>;
  rootRunIdsByThread?: Record<string, string>;
  terminalEventIdsByThread?: Record<string, string>;
  label?: string;
  conversationId: string;
}) {
  // Bumped by the stale-deadline timer so the working check re-evaluates its
  // time-based branch on its own rather than waiting for an unrelated render.
  const [tick, setTick] = useState(0);
  const { working, paused, nextStaleDeadlineMs } = useMemo(
    () =>
      computeWorking(
        threadIds,
        completedThreadIds ?? [],
        pausedThreadIds ?? [],
        failedThreadIds ?? [],
        supersededThreadIds ?? [],
        spawnedAtMs ?? {},
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      threadIds,
      completedThreadIds,
      pausedThreadIds,
      failedThreadIds,
      supersededThreadIds,
      spawnedAtMs,
      tick,
    ],
  );

  // Live status for a single-thread card: agent-progress ticks are
  // ephemeral decoration (never persisted), so the working subtitle
  // subscribes straight to this thread's decoration in the module store —
  // one tick re-renders this card only, and it works on every surface
  // (full chat, sidebar, mini) without threading props through the rows.
  const liveThreadId = threadIds.length === 1 ? threadIds[0] : undefined;
  const liveDecoration = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        liveThreadId
          ? subscribeTaskDecoration(liveThreadId, listener)
          : () => {},
      [liveThreadId],
    ),
    () => (liveThreadId ? getTaskDecoration(liveThreadId) : undefined),
  );
  const { records: threadActivity } = useThreadActivity(conversationId);

  // The card mounting grows its row outside the streaming-text notify path
  // (a spawn lands as a tool event, not a text chunk) — tell the scroll
  // surfaces so auto-follow keeps the card in frame. See
  // `notifyChatContentGrowth`.
  useLayoutEffect(() => {
    notifyChatContentGrowth();
  }, []);

  // While a thread reads as working only because it hasn't yet crossed the
  // stale threshold, arm a one-shot timer for that deadline so the card
  // settles itself even if no further signal ever arrives.
  useEffect(() => {
    if (nextStaleDeadlineMs === undefined) return;
    const delay = Math.max(0, nextStaleDeadlineMs - Date.now()) + 100;
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [nextStaleDeadlineMs]);

  const resolved = resolveDescriptions(threadIds, descriptions ?? {});
  const multi = threadIds.length > 1;

  // A single-thread card whose one thread was re-activated via `send_input`
  // renders as a follow-up: its own message (the spawn description is stale
  // for an update). Multi-thread cards stay a plain spawn tally — that
  // collapse is about volume, not the spawn/update distinction.
  const followUpId =
    !multi && followUpThreadIds?.includes(threadIds[0])
      ? threadIds[0]
      : undefined;
  const isFollowUp = followUpId !== undefined;

  // Several threads in one turn collapse to a plain count instead of cycling
  // through descriptions — a single task shows its own description.
  const lifecycleTitle = isFollowUp
    ? statusTexts?.[followUpId] || resolved[0] || label?.trim() || "Follow-up"
    : multi
      ? label?.trim() || resolved[0] || `${threadIds.length} tasks`
      : resolved[0] || label?.trim() || "Background work";

  const latestAuthoredMessage = useMemo(() => {
    let latest: { text: string; at: number } | undefined;
    for (const threadId of threadIds) {
      const record = threadActivity.find(
        (entry) => entry.threadId === threadId,
      );
      const at = record?.assistantMessagesUpdatedAt ?? 0;
      const currentAttemptStartedAt = spawnedAtMs?.[threadId] ?? 0;
      const text = record?.assistantMessages?.at(-1)?.trim();
      if (
        text &&
        at >= currentAttemptStartedAt &&
        (!latest || at > latest.at)
      ) {
        latest = { text, at };
      }
    }
    return latest?.text;
  }, [spawnedAtMs, threadActivity, threadIds]);
  if (threadIds.length === 0) return null;
  const title = latestAuthoredMessage ?? lifecycleTitle;

  // "Paused" only replaces the ACTIVE presentation: while any covered thread
  // is still genuinely working the card keeps its shimmer + normal subtitle,
  // and a settled card keeps its plain historical label.
  const failed = (failedThreadIds?.length ?? 0) > 0;
  const showPaused = paused && !working && !failed;
  // Live decoration wins over the (reload-only, historical) persisted
  // progress props; both are absent for multi-thread tally cards.
  const progressText = !multi
    ? (liveDecoration?.statusText ?? progressTexts?.[threadIds[0]])
    : undefined;
  const toolActivity = !multi
    ? (liveDecoration?.toolActivity ?? toolActivities?.[threadIds[0]])
    : undefined;
  const lifecycleSubtitle = failed
    ? "Failed"
    : showPaused
      ? "Paused"
      : working && toolActivity
        ? friendlyInlineToolStatus(toolActivity)
        : working && progressText && progressText !== title
          ? progressText
          : isFollowUp
            ? "Follow-up sent"
            : "Started in background";
  const subtitle = latestAuthoredMessage
    ? working
      ? `Working · ${lifecycleTitle}`
      : lifecycleTitle
    : lifecycleSubtitle;
  const startEventIds = threadIds
    .map((id) => startEventIdsByThread[id])
    .filter(Boolean);
  const rootRunIds = [
    ...new Set(threadIds.map((id) => rootRunIdsByThread?.[id]).filter(Boolean)),
  ];
  const terminalEventIds = threadIds
    .map((id) => terminalEventIdsByThread?.[id])
    .filter(Boolean);

  return (
    <div
      className="background-work-card"
      data-state={failed ? "failed" : isFollowUp ? "follow-up" : "started"}
      data-working={working ? "true" : undefined}
      data-paused={showPaused ? "true" : undefined}
      data-activity-card-id={cardId}
      data-agent-ids={threadIds.join(",")}
      data-start-event-ids={startEventIds.join(",")}
      data-root-run-ids={rootRunIds.join(",")}
      data-terminal-event-ids={terminalEventIds.join(",")}
    >
      <span className="background-work-card__glyph" aria-hidden="true">
        {failed ? (
          <X size={16} strokeWidth={1.75} />
        ) : isFollowUp ? (
          <Check size={16} strokeWidth={1.75} />
        ) : (
          <Send size={16} strokeWidth={1.75} />
        )}
      </span>
      <span className="background-work-card__text">
        <span className="background-work-card__title">
          {working ? (
            <TextShimmer text={title} durationMs={TITLE_SHIMMER_MS} />
          ) : (
            title
          )}
        </span>
        <span className="background-work-card__subtitle">{subtitle}</span>
      </span>
      <span className="background-work-card__actions">
        {threadIds.map((threadId) => (
          <button
            key={threadId}
            type="button"
            className="background-work-card__chat"
            onClick={() =>
              openAgentThreadTab({
                threadId,
                conversationId,
                agentType:
                  threadActivity.find((record) => record.threadId === threadId)
                    ?.agentType ?? "Agent",
                title:
                  descriptions?.[threadId]?.trim() ||
                  label?.trim() ||
                  "Agent thread",
              })
            }
            aria-label={`Open read-only chat for ${descriptions?.[threadId]?.trim() || "agent"}`}
            title="Open read-only chat"
          >
            <MessageSquare size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ))}
      </span>
    </div>
  );
}
