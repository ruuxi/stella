/**
 * Inline "background work" card.
 *
 * Surfaces, in the chat flow itself, when Stella kicks something off in
 * the background — the friendly, normie-facing counterpart to the
 * artifact cards. Several pieces of work started in the same turn collapse
 * into this one card (it just tallies them as a count) rather than stacking
 * a card per thread or cycling through their descriptions.
 *
 * Presence/identity is derived from the spawning turn's tool events
 * (`useEventRows`); the live status comes from `BackgroundWorkProvider`.
 * While anything is still in progress the title shimmers, so the in-progress
 * state reads at a glance; it settles into a quiet "finished" once everything
 * wraps up.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, AlertCircle } from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
import {
  isGenericTaskDescription,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { useBackgroundWorkTasks } from "./background-work-context";
import "./background-work-card.css";

type BackgroundWorkState = "running" | "done" | "error" | "canceled";

type BackgroundWorkAggregate = {
  state: BackgroundWorkState;
  total: number;
  completed: number;
  /** Earliest time (ms) at which an in-window no-signal thread crosses the
   *  stale threshold and flips to settled. The card arms a one-shot timer
   *  for it so the transition happens on its own, not on the next unrelated
   *  render. Undefined when nothing is pending on a deadline. */
  nextStaleDeadlineMs?: number;
};

/** A thread with no live or persisted signal that was spawned longer ago
 *  than this is presumed settled (its lifecycle aged out of the loaded
 *  windows) rather than pinned as forever-working. Comfortably longer than
 *  the spawn → first-task-event latency, so a genuinely fresh spawn still
 *  reads as working until its live status lands. */
const STALE_NO_SIGNAL_MS = 5 * 60_000;

function aggregate(
  threadIds: string[],
  completedThreadIds: readonly string[],
  supersededThreadIds: readonly string[],
  spawnedAtMs: Record<string, number>,
  tasks: ReadonlyMap<string, TaskItem>,
): BackgroundWorkAggregate {
  const completedSet = new Set(completedThreadIds);
  const supersededSet = new Set(supersededThreadIds);
  const now = Date.now();
  let running = 0;
  let completed = 0;
  let errored = 0;
  let pending = 0;
  let nextStaleDeadlineMs: number | undefined;

  for (const id of threadIds) {
    // A later turn's card now owns this thread's live status — freeze it
    // here as settled so this (earlier) card doesn't re-animate on revival.
    if (supersededSet.has(id)) {
      completed += 1;
      continue;
    }
    const status = tasks.get(id)?.status;
    // Live status wins over the reload-safe completed set: a thread that
    // completed and was revived reads as running again, not done.
    if (status === "running") {
      running += 1;
    } else if (status === "error") {
      errored += 1;
    } else if (status === "canceled") {
      // Terminal but neither success nor failure — settled, count nowhere.
      continue;
    } else if (status === "completed" || completedSet.has(id)) {
      completed += 1;
    } else {
      // No live or persisted signal. A fresh spawn reads as working; one
      // whose lifecycle aged out of the loaded windows is presumed settled
      // so the card doesn't shimmer "working" forever after a reload.
      const spawnedAt = spawnedAtMs[id];
      if (spawnedAt && now - spawnedAt > STALE_NO_SIGNAL_MS) {
        completed += 1;
      } else {
        pending += 1;
        if (spawnedAt) {
          const deadline = spawnedAt + STALE_NO_SIGNAL_MS;
          if (
            nextStaleDeadlineMs === undefined ||
            deadline < nextStaleDeadlineMs
          ) {
            nextStaleDeadlineMs = deadline;
          }
        }
      }
    }
  }

  const inProgress = running + pending;
  const state: BackgroundWorkState =
    inProgress > 0
      ? "running"
      : errored > 0
        ? "error"
        : completed > 0
          ? "done"
          : "canceled";

  return {
    state,
    total: threadIds.length,
    completed,
    // Only arm a timer while the card is still showing work — once settled,
    // crossing a deadline wouldn't change anything.
    ...(inProgress > 0 && nextStaleDeadlineMs !== undefined
      ? { nextStaleDeadlineMs }
      : {}),
  };
}

const STATUS_LABEL: Record<BackgroundWorkState, string> = {
  running: "Working in background",
  done: "Finished",
  error: "Couldn’t finish",
  canceled: "Stopped",
};

/** Sweep duration for the title shimmer — a touch quicker than the
 *  base TextShimmer so the in-progress state reads as lively. */
const TITLE_SHIMMER_MS = 1900;

/** Per-thread descriptions in spawn order (live task description wins,
 *  falling back to the reload-safe description captured on the row). */
function resolveDescriptions(
  threadIds: string[],
  descriptions: Record<string, string>,
  tasks: ReadonlyMap<string, TaskItem>,
): string[] {
  const out: string[] = [];
  for (const id of threadIds) {
    const live = tasks.get(id)?.description;
    const resolved =
      live && !isGenericTaskDescription(live) ? live : descriptions[id];
    if (resolved) out.push(resolved);
  }
  return out;
}

function statusFor(agg: BackgroundWorkAggregate): string {
  if (agg.state === "running" && agg.total > 1) {
    return `${agg.completed} of ${agg.total} done`;
  }
  return STATUS_LABEL[agg.state];
}

export function BackgroundWorkCard({
  threadIds,
  completedThreadIds,
  supersededThreadIds,
  spawnedAtMs,
  descriptions,
  label,
}: {
  threadIds: string[];
  completedThreadIds?: string[];
  supersededThreadIds?: string[];
  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;
  label?: string;
}) {
  const tasks = useBackgroundWorkTasks();
  // Bumped by the stale-deadline timer so the aggregate re-evaluates its
  // time-based check on its own rather than waiting for an unrelated render.
  const [tick, setTick] = useState(0);
  const agg = useMemo(
    () =>
      aggregate(
        threadIds,
        completedThreadIds ?? [],
        supersededThreadIds ?? [],
        spawnedAtMs ?? {},
        tasks,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      threadIds,
      completedThreadIds,
      supersededThreadIds,
      spawnedAtMs,
      tasks,
      tick,
    ],
  );

  // When a thread is still showing as working only because it hasn't yet
  // crossed the stale threshold, arm a one-shot timer for that deadline so
  // the card settles itself even if no further signal ever arrives.
  const nextStaleDeadlineMs = agg.nextStaleDeadlineMs;
  useEffect(() => {
    if (nextStaleDeadlineMs === undefined) return;
    const delay = Math.max(0, nextStaleDeadlineMs - Date.now()) + 100;
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [nextStaleDeadlineMs]);

  const resolved = useMemo(
    () => resolveDescriptions(threadIds, descriptions ?? {}, tasks),
    [threadIds, descriptions, tasks],
  );

  if (threadIds.length === 0) return null;

  const isRunning = agg.state === "running";
  const multi = threadIds.length > 1;

  // Several threads in one turn collapse to a plain count instead of cycling
  // through descriptions — a single task shows its own description.
  const title = multi
    ? isRunning
      ? `Working on ${agg.total} tasks`
      : label?.trim() || resolved[0] || `${agg.total} tasks`
    : resolved[0] || label?.trim() || "Background work";
  const status = statusFor(agg);

  const titleNode = isRunning ? (
    <TextShimmer text={title} durationMs={TITLE_SHIMMER_MS} />
  ) : (
    title
  );

  return (
    <div className="background-work-card" data-state={agg.state}>
      {!isRunning && (
        <span className="background-work-card__glyph" aria-hidden="true">
          {agg.state === "error" ? (
            <AlertCircle size={16} strokeWidth={1.75} />
          ) : agg.state === "canceled" ? (
            <span className="background-work-card__dot" />
          ) : (
            <Check size={16} strokeWidth={2} />
          )}
        </span>
      )}
      <span className="background-work-card__text">
        <span className="background-work-card__title">{titleNode}</span>
        <span className="background-work-card__subtitle">{status}</span>
      </span>
    </div>
  );
}
