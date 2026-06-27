/**
 * Composer activity pill — the single, always-present marker that sits in
 * the context chip row above the composer.
 *
 * It does double duty:
 *   • Idle, it's the entry point to search — a search icon + "Search". This
 *     replaces the old left-sidebar search row.
 *   • While Stella has background work in flight it shows the live status:
 *     a soft pulse + the rotating work description (the same cadence the
 *     old inline background-work card used). When work settles it briefly
 *     shows a finished / couldn't-finish / stopped state before quietly
 *     reverting to "Search" — a minimum dwell so a quick task doesn't just
 *     flash its progress.
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
import {
  extractTasksFromActivities,
  getTaskDisplayText,
  mergeFooterTasks,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import "./composer-activity-pill.css";

type PillState = "idle" | "running" | "done" | "error" | "canceled";

/** Sweep for the running-title shimmer — matches the old inline card. */
const TITLE_SHIMMER_MS = 1900;
/** Cadence for cycling through in-flight work descriptions. */
const ROTATE_INTERVAL_MS = 3500;
/** Duration of one carousel slide between descriptions. */
const CAROUSEL_SLIDE_MS = 460;
/** Above this many concurrent tasks, page dots stop reading as a count —
 *  fall back to a single running dot (the carousel still cycles them all). */
const MAX_PIPS = 5;
/** Keep a settled (finished / failed / stopped) state visible at least
 *  this long before reverting to idle, so quick work doesn't flash. */
const TERMINAL_DWELL_MS = 2800;

const EMPTY_TASKS: TaskItem[] = [];

const STATUS_FALLBACK: Record<Exclude<PillState, "idle">, string> = {
  running: "Working…",
  done: "Finished",
  error: "Couldn’t finish",
  canceled: "Stopped",
};

/** Live status of the whole conversation's background work, distilled into
 *  a single pill state with a minimum dwell on terminal states. */
function useActivityPillState(tasks: TaskItem[]): {
  state: PillState;
  activeDescriptions: string[];
} {
  const runningTasks = useMemo(
    () => tasks.filter((task) => task.status === "running"),
    [tasks],
  );
  const runningKey = useMemo(
    () => runningTasks.map((task) => task.id).join("\u0000"),
    [runningTasks],
  );

  const activeDescriptions = useMemo(() => {
    const out: string[] = [];
    for (const task of runningTasks) {
      const text = (getTaskDisplayText(task) || task.description || "").trim();
      if (text) out.push(text);
    }
    return out;
  }, [runningTasks]);

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

  return { state, activeDescriptions };
}

function PillGlyph({ state }: { state: PillState }) {
  switch (state) {
    case "running":
      return (
        <span className="composer-activity-pill__dot composer-activity-pill__dot--running" />
      );
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
  const activities = chat.conversation.activity.activities;
  const latestMessageTimestampMs =
    chat.conversation.activity.latestMessageTimestampMs;
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;

  const tasks = useMemo(
    () =>
      mergeFooterTasks(
        extractTasksFromActivities(activities, {
          appSessionStartedAtMs,
          latestMessageTimestampMs,
        }),
        liveTasks,
      ),
    [activities, appSessionStartedAtMs, latestMessageTimestampMs, liveTasks],
  );

  const { state, activeDescriptions } = useActivityPillState(tasks);

  const len = activeDescriptions.length;
  const rotating = state === "running" && len > 1;
  const rotationSignature = activeDescriptions.join("\u0000");

  // Carousel position advances 0,1,2,… When it lands on the appended clone
  // of the first line (position === len) we let the slide finish, then snap
  // back to 0 with the transition off — so the loop reads as one continuous
  // upward scroll instead of jumping backwards.
  const [position, setPosition] = useState(0);
  const [animate, setAnimate] = useState(true);

  useEffect(() => {
    setPosition(0);
    setAnimate(true);
  }, [rotationSignature]);

  useEffect(() => {
    if (!rotating) return;
    const interval = window.setInterval(() => {
      setAnimate(true);
      setPosition((p) => p + 1);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [rotating, rotationSignature]);

  useEffect(() => {
    if (!rotating || position !== len) return;
    const timer = window.setTimeout(() => {
      setAnimate(false);
      setPosition(0);
    }, CAROUSEL_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, position, len]);

  const shownIndex = len > 0 ? position % len : 0;
  const runningTitle =
    len > 0 ? activeDescriptions[shownIndex] : STATUS_FALLBACK.running;

  // Hold onto the last running description so the settled state can echo
  // what just finished instead of snapping to a generic label.
  const lastTitleRef = useRef("");
  useEffect(() => {
    if (state === "running") lastTitleRef.current = runningTitle;
  }, [state, runningTitle]);

  const [open, setOpen] = useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) displaySearchStore.clear();
  };

  let label: string;
  if (state === "idle") {
    label = "Search";
  } else if (state === "running") {
    label = runningTitle;
  } else {
    label = lastTitleRef.current || STATUS_FALLBACK[state];
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
            {state === "running" && len > 1 && len <= MAX_PIPS ? (
              <span className="composer-activity-pill__pips">
                {activeDescriptions.map((_, index) => (
                  <span
                    key={index}
                    className="composer-activity-pill__pip"
                    data-active={index === shownIndex || undefined}
                  />
                ))}
              </span>
            ) : (
              <PillGlyph state={state} />
            )}
          </span>
          <span className="composer-activity-pill__label">
            {rotating ? (
              <span className="composer-activity-pill__carousel">
                <span
                  className="composer-activity-pill__carousel-track"
                  style={{
                    transform: `translateY(calc(${position} * -1lh))`,
                    transition: animate
                      ? `transform ${CAROUSEL_SLIDE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
                      : "none",
                  }}
                >
                  {[...activeDescriptions, activeDescriptions[0]].map(
                    (description, index) => (
                      <span
                        key={index}
                        className="composer-activity-pill__carousel-item"
                      >
                        <TextShimmer
                          text={description}
                          durationMs={TITLE_SHIMMER_MS}
                        />
                      </span>
                    ),
                  )}
                </span>
              </span>
            ) : (
              labelNode
            )}
          </span>
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
