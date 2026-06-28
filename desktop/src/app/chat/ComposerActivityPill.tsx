/**
 * Composer activity pill — the single, always-present marker that sits in
 * the context chip row above the composer.
 *
 * It does double duty:
 *   • Idle, it's the entry point to search — a search icon + "Search". This
 *     replaces the old left-sidebar search row.
 *   • While Stella has background work in flight it shows a simple,
 *     shimmering count of how many things are running ("1 task", "2
 *     tasks", …) — the per-task detail lives in the inline chat cards and
 *     the tray, so the ambient pill just tallies. When work settles it
 *     briefly shows a finished / couldn't-finish / stopped state before
 *     quietly reverting to "Search" — a minimum dwell so a quick task
 *     doesn't just flash its progress.
 *
 * Clicking it (in any state) opens a tray with the searchable Activity /
 * Files / Schedule overview.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Search } from "@/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useAgentSessionStartedAt } from "@/features/chat/hooks/use-agent-session-started-at";
import { useMergedBackgroundTasks } from "@/features/chat/hooks/use-merged-background-tasks";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import "./composer-activity-pill.css";

type PillState = "idle" | "running" | "done" | "error" | "canceled";

/** Sweep for the running-title shimmer — matches the inline card. */
const TITLE_SHIMMER_MS = 1900;
/** Keep a settled (finished / failed / stopped) state visible at least
 *  this long before reverting to idle, so quick work doesn't flash. */
const TERMINAL_DWELL_MS = 2800;

const STATUS_FALLBACK: Record<Exclude<PillState, "idle">, string> = {
  running: "Task in progress",
  done: "Finished",
  error: "Couldn’t finish",
  canceled: "Stopped",
};

/** Live status of the whole conversation's background work, distilled into
 *  a single pill state (+ running count) with a minimum dwell on terminal
 *  states. */
function useActivityPillState(tasks: TaskItem[]): {
  state: PillState;
  runningCount: number;
} {
  const runningTasks = useMemo(
    () => tasks.filter((task) => task.status === "running"),
    [tasks],
  );
  const runningKey = useMemo(
    () => runningTasks.map((task) => task.id).join("\u0000"),
    [runningTasks],
  );
  const runningCount = runningTasks.length;

  const [state, setState] = useState<PillState>("idle");
  const prevRunningIdsRef = useRef<string[]>([]);
  const settleTimerRef = useRef<number | null>(null);
  // Read fresh statuses at the falling edge without re-arming the effect on
  // every task tick (only running-set changes drive a transition).
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    const prev = prevRunningIdsRef.current;
    const running = runningKey ? runningKey.split("\u0000") : [];

    if (running.length > 0) {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setState("running");
    } else if (prev.length > 0) {
      // Work just wound down — settle into the terminal outcome of the
      // threads that were running, then revert to idle after the dwell.
      const statusById = new Map(
        tasksRef.current.map((task) => [task.id, task.status]),
      );
      let anyError = false;
      let anyDone = false;
      let anyCanceled = false;
      for (const id of prev) {
        const status = statusById.get(id);
        if (status === "error") anyError = true;
        else if (status === "canceled") anyCanceled = true;
        else anyDone = true;
      }
      const terminal: PillState = anyError
        ? "error"
        : anyDone
          ? "done"
          : anyCanceled
            ? "canceled"
            : "done";
      setState(terminal);
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => {
        setState("idle");
        settleTimerRef.current = null;
      }, TERMINAL_DWELL_MS);
    }

    prevRunningIdsRef.current = running;
  }, [runningKey]);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
    },
    [],
  );

  return { state, runningCount };
}

function PillGlyph({ state }: { state: PillState }) {
  switch (state) {
    case "running":
      // No glyph while running — the shimmering count carries the state.
      return null;
    case "done":
      return <Check size={15} strokeWidth={2} aria-hidden="true" />;
    case "error":
      return <AlertCircle size={15} strokeWidth={1.75} aria-hidden="true" />;
    case "canceled":
      return <span className="composer-activity-pill__dot" />;
    case "idle":
      return <Search size={15} strokeWidth={1.75} aria-hidden="true" />;
  }
}

function ActivityTray({ onNavigate }: { onNavigate: () => void }) {
  const query = useDisplaySearchQuery();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="composer-activity-tray">
      <div className="composer-activity-tray__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          className="composer-activity-tray__search-input"
          value={query}
          placeholder="Search activity, files, and more"
          onChange={(event) =>
            displaySearchStore.setQuery(event.currentTarget.value)
          }
          aria-label="Search activity, files, and more"
        />
      </div>
      <div className="composer-activity-tray__body">
        <LeftSidebarSections
          query={query}
          variant="overview"
          onNavigate={onNavigate}
          renderEmpty={() => (
            <div className="composer-activity-tray__empty">
              {query.trim()
                ? "Nothing matches that search."
                : "Activity will show up here as Stella works."}
            </div>
          )}
        />
      </div>
    </div>
  );
}

export function ComposerActivityPill() {
  const chat = useChatRuntime();
  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const tasks = useMergedBackgroundTasks({
    activities: chat.conversation.activity.activities,
    liveTasks: chat.conversation.streaming.liveTasks,
    latestMessageTimestampMs:
      chat.conversation.activity.latestMessageTimestampMs,
    appSessionStartedAtMs,
  });

  const { state, runningCount } = useActivityPillState(tasks);

  const [open, setOpen] = useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) displaySearchStore.clear();
  };

  let label: string;
  if (state === "idle") {
    label = "Search";
  } else if (state === "running") {
    // A single task reads as a generic "in progress" — no count, no
    // description (the per-task detail lives in the inline cards / tray).
    // Several at once earn a tally in the same phrasing.
    label =
      runningCount > 1
        ? `${runningCount} tasks in progress`
        : STATUS_FALLBACK.running;
  } else {
    label = STATUS_FALLBACK[state];
  }

  const labelNode: ReactNode =
    state === "running" ? (
      <TextShimmer text={label} durationMs={TITLE_SHIMMER_MS} />
    ) : (
      label
    );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="composer-activity-pill"
          data-state={state}
          data-open={open || undefined}
          aria-label={state === "idle" ? "Search" : `${label} — open activity`}
        >
          <span className="composer-activity-pill__glyph" aria-hidden="true">
            <PillGlyph state={state} />
          </span>
          <span className="composer-activity-pill__label">{labelNode}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="composer-activity-tray-popover"
      >
        <ActivityTray onNavigate={() => handleOpenChange(false)} />
      </PopoverContent>
    </Popover>
  );
}
