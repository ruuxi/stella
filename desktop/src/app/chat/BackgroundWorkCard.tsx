/**
 * Inline "background work" card.
 *
 * Surfaces, in the chat flow itself, when Stella kicks something off in
 * the background — the friendly, normie-facing counterpart to the
 * artifact cards. Several pieces of work started in the same turn collapse
 * into this one card (it just tallies them) rather than stacking a card
 * per thread.
 *
 * Presence/identity is derived from the spawning turn's tool events
 * (`useEventRows`); the live status comes from `BackgroundWorkProvider`.
 * While anything is still in progress the title shimmers and a soft pulse
 * plays, so the in-progress state reads at a glance; it settles into a
 * quiet "finished" once everything wraps up.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, AlertCircle } from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
import {
  normalizeTaskDisplayStatusText,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { useBackgroundWorkTasks } from "./background-work-context";
import "./background-work-card.css";

type BackgroundWorkState = "running" | "done" | "error" | "canceled";

type BackgroundWorkAggregate = {
  state: BackgroundWorkState;
  total: number;
  completed: number;
  /** Live narration from the most-relevant running thread, when present. */
  statusText?: string;
};

function aggregate(
  threadIds: string[],
  completedThreadIds: readonly string[],
  tasks: ReadonlyMap<string, TaskItem>,
): BackgroundWorkAggregate {
  const completedSet = new Set(completedThreadIds);
  let running = 0;
  let completed = 0;
  let errored = 0;
  let pending = 0;
  let statusText: string | undefined;

  for (const id of threadIds) {
    const status = tasks.get(id)?.status;
    if (status === "error") {
      errored += 1;
    } else if (status === "canceled") {
      // Terminal but neither success nor failure — settled, count nowhere.
      continue;
    } else if (status === "completed" || completedSet.has(id)) {
      completed += 1;
    } else if (status === "running") {
      running += 1;
      if (!statusText) {
        statusText = normalizeTaskDisplayStatusText(tasks.get(id)?.statusText);
      }
    } else {
      // Spawned but no lifecycle signal yet (or beyond the loaded window):
      // treat as in-progress so a fresh spawn reads as working immediately.
      pending += 1;
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

  return { state, total: threadIds.length, completed, statusText };
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
/** How long each description stays up before rotating to the next, when
 *  several threads run at once. Matches the shared indicator cadence. */
const ROTATE_INTERVAL_MS = 3500;

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
    const resolved = live && live !== "Task" ? live : descriptions[id];
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
  descriptions,
  label,
}: {
  threadIds: string[];
  completedThreadIds?: string[];
  descriptions?: Record<string, string>;
  label?: string;
}) {
  const tasks = useBackgroundWorkTasks();
  const agg = useMemo(
    () => aggregate(threadIds, completedThreadIds ?? [], tasks),
    [threadIds, completedThreadIds, tasks],
  );

  const resolved = useMemo(
    () => resolveDescriptions(threadIds, descriptions ?? {}, tasks),
    [threadIds, descriptions, tasks],
  );

  // Descriptions of threads still in flight — the ticker cycles through
  // these so a finished item doesn't show up shimmering as "working".
  const activeDescriptions = useMemo(() => {
    const done = new Set(completedThreadIds ?? []);
    const active = threadIds.filter((id) => {
      const status = tasks.get(id)?.status;
      if (status === "completed" || status === "error" || status === "canceled")
        return false;
      return !done.has(id);
    });
    return resolveDescriptions(active, descriptions ?? {}, tasks);
  }, [threadIds, completedThreadIds, descriptions, tasks]);

  const isRunning = agg.state === "running";
  const multi = threadIds.length > 1;
  // While several threads run, cycle through the in-flight descriptions
  // instead of pinning the group label; once settled (or for a single
  // thread) the title holds steady.
  const rotating = isRunning && multi && activeDescriptions.length > 1;

  const [rotateIndex, setRotateIndex] = useState(0);
  const rotationSignature = activeDescriptions.join("\u0000");

  useEffect(() => {
    if (!rotating) {
      setRotateIndex(0);
      return;
    }
    const interval = window.setInterval(() => {
      setRotateIndex((index) => index + 1);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // rotationSignature re-arms the timer when the description set changes.
  }, [rotating, rotationSignature]);

  if (threadIds.length === 0) return null;

  const staticTitle = multi
    ? label?.trim() || resolved[0] || "Background work"
    : resolved[0] || label?.trim() || "Background work";
  const title =
    rotating && activeDescriptions.length > 0
      ? activeDescriptions[rotateIndex % activeDescriptions.length]
      : staticTitle;
  const status = statusFor(agg);

  const titleNode = isRunning ? (
    <TextShimmer text={title} durationMs={TITLE_SHIMMER_MS} />
  ) : (
    title
  );

  return (
    <div className="background-work-card" data-state={agg.state}>
      <span className="background-work-card__glyph" aria-hidden="true">
        {agg.state === "running" ? (
          <span className="background-work-card__pulse" />
        ) : agg.state === "error" ? (
          <AlertCircle size={16} strokeWidth={1.75} />
        ) : agg.state === "canceled" ? (
          <span className="background-work-card__dot" />
        ) : (
          <Check size={16} strokeWidth={2} />
        )}
      </span>
      <span className="background-work-card__text">
        <span className="background-work-card__title">
          {rotating ? (
            // Keyed per rotation so each description plays the roll-up
            // enter animation as it cycles in.
            <span key={rotateIndex} className="background-work-card__title-roll">
              {titleNode}
            </span>
          ) : (
            titleNode
          )}
        </span>
        <span className="background-work-card__subtitle">{status}</span>
      </span>
    </div>
  );
}
