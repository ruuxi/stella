/**
 * Inline "background work" card — a spawn/update breadcrumb that shimmers
 * while its work is still running.
 *
 * Marks, in the chat flow itself, the spot where Stella kicked something
 * off in the background. The card records "this task was triggered here" at
 * spawn time and stays put as a historical anchor — it never flips to a
 * finished narration or tallies completion counts (that lives in the
 * dedicated finished surfaces). Its one live tell is the title shimmer:
 * while any thread the card covers is still working the title shimmers
 * (matching the sidebar Activity surface), and it settles into a plain
 * title once everything has completed / aged out. Several pieces of work
 * started in the same turn collapse into this one card (it just tallies
 * them as a count) rather than stacking a card per thread.
 *
 * Two variants share the same surface:
 *   - spawn ("started X" — `spawn_agent` kicked off new background work)
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
import { useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, Send } from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
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
  supersededThreadIds: readonly string[],
  spawnedAtMs: Record<string, number>,
): { working: boolean; nextStaleDeadlineMs?: number } {
  const completedSet = new Set(completedThreadIds);
  const supersededSet = new Set(supersededThreadIds);
  const now = Date.now();
  let working = false;
  let nextStaleDeadlineMs: number | undefined;

  for (const id of threadIds) {
    // A later turn's card owns this thread's live status now — treat it as
    // settled here so this (earlier) card doesn't shimmer on revival.
    if (supersededSet.has(id)) continue;
    // Its `agent-completed` has landed in the message stream.
    if (completedSet.has(id)) continue;
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
  supersededThreadIds,
  spawnedAtMs,
  descriptions,
  statusTexts,
  followUpThreadIds,
  label,
}: {
  threadIds: string[];
  /** Reload-safe subset whose `agent-completed` event has landed — used to
   *  decide whether the title still shimmers. */
  completedThreadIds?: string[];
  /** Subset a later turn's card now owns; frozen as settled here. */
  supersededThreadIds?: string[];
  /** Per-thread spawn/last-advanced time (ms) for the stale-spawn fallback. */
  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;
  /** Per-thread follow-up text for `send_input` re-activations. */
  statusTexts?: Record<string, string>;
  /** Threads on this card that are `send_input` follow-ups, not fresh spawns. */
  followUpThreadIds?: string[];
  label?: string;
}) {
  // Bumped by the stale-deadline timer so the working check re-evaluates its
  // time-based branch on its own rather than waiting for an unrelated render.
  const [tick, setTick] = useState(0);
  const { working, nextStaleDeadlineMs } = useMemo(
    () =>
      computeWorking(
        threadIds,
        completedThreadIds ?? [],
        supersededThreadIds ?? [],
        spawnedAtMs ?? {},
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadIds, completedThreadIds, supersededThreadIds, spawnedAtMs, tick],
  );

  // While a thread reads as working only because it hasn't yet crossed the
  // stale threshold, arm a one-shot timer for that deadline so the card
  // settles itself even if no further signal ever arrives.
  useEffect(() => {
    if (nextStaleDeadlineMs === undefined) return;
    const delay = Math.max(0, nextStaleDeadlineMs - Date.now()) + 100;
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [nextStaleDeadlineMs]);

  if (threadIds.length === 0) return null;

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
  const title = isFollowUp
    ? statusTexts?.[followUpId] || resolved[0] || label?.trim() || "Follow-up"
    : multi
      ? label?.trim() || resolved[0] || `${threadIds.length} tasks`
      : resolved[0] || label?.trim() || "Background work";

  return (
    <div
      className="background-work-card"
      data-state={isFollowUp ? "follow-up" : "started"}
      data-working={working ? "true" : undefined}
    >
      <span className="background-work-card__glyph" aria-hidden="true">
        {isFollowUp ? (
          <MessageSquarePlus size={16} strokeWidth={1.75} />
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
        <span className="background-work-card__subtitle">
          {isFollowUp ? "Follow-up sent" : "Started in background"}
        </span>
      </span>
    </div>
  );
}
