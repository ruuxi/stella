/**
 * Composer activity pill — the compact presentation of background work that
 * sits in the context chip row above the composer.
 *
 * It stays visible regardless of the docked left sidebar state so search is
 * always available above the composer. While the sidebar is visible, its
 * Activity section owns live progress and the pill stays in its Search state.
 *
 * The pill does double duty:
 *   • Idle, it's the entry point to search — a search icon + "Search".
 *   • While Stella has background work in flight it shows a simple,
 *     shimmering count of how many top-level work units are running ("1 task in progress",
 *     "2 tasks in progress", …) — the per-task detail lives in the inline
 *     chat cards and the tray, so the ambient pill just tallies. When work
 *     settles it briefly shows a finished / couldn't-finish / stopped state
 *     before quietly reverting to "Search" — a minimum dwell so a quick task
 *     doesn't just flash its progress.
 *
 * Clicking it (in any state) opens the tray: the searchable activity
 * overview (`LeftSidebarSections`, the same component the sidebar hosts —
 * expand/collapse, reasoning summaries, live per-agent files).
 */
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertCircle, Check, Search } from "@/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import {
  CHAT_ACTIVITY_SHIMMER_GROUP,
  TextShimmer,
} from "@/app/chat/TextShimmer";
import { useChatRuntime } from "@/context/use-chat-runtime";
import {
  deriveTopLevelActivityWorkUnits,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import "./composer-activity-pill.css";

export type PillState = "idle" | "running" | "done" | "error" | "canceled";

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

export const getActivityPillLabel = (
  state: PillState,
  runningCount: number,
): string => {
  if (state === "idle") return "Search";
  if (state === "running") {
    return `${runningCount} ${runningCount === 1 ? "task" : "tasks"} in progress`;
  }
  return STATUS_FALLBACK[state];
};

/**
 * The pill stands down from its live "running" label whenever the Tasks
 * surface is already on screen, so the two never narrate the same progress at
 * once. That used to mean "the left sidebar is docked"; with the sidebar gone
 * the equivalent condition is the right sidebar being open on its Tasks
 * section.
 */
export const getDisplayedActivityPillState = (
  state: PillState,
  tasksSurfaceVisible: boolean,
): PillState => (tasksSurfaceVisible && state === "running" ? "idle" : state);

/**
 * Whether the tray should hold its fixed "searching" layout (a resolved,
 * scroll-bounded results box) rather than its natural content-fit height.
 *
 * Two inputs, deliberately OR'd:
 *   • `inputValue` — the immediate keystroke value, so the fixed box engages
 *     on the very first character, before the debounced/deferred results
 *     reconcile (no first-keystroke jump).
 *   • `deferredQuery` — the value the results are actually rendered from.
 *     Holding on it keeps the fixed layout in place after the field is
 *     cleared until the results reconcile back to the overview, so clearing
 *     collapses the box exactly once (a single settle) instead of dropping
 *     the layout immediately and resizing again 150ms later when the query
 *     clears (the two-stage drop).
 */
export const shouldTrayHoldSearchLayout = (
  inputValue: string,
  deferredQuery: string,
): boolean => inputValue.trim().length > 0 || deferredQuery.trim().length > 0;

/** Live status of the whole conversation's background work, distilled into
 *  a single pill state (+ running count) with a minimum dwell on terminal
 *  states. */
function useActivityPillState(tasks: TaskItem[]): {
  state: PillState;
  runningCount: number;
} {
  // Count the same durable top-level work units the Activity hierarchy shows:
  // standalone agents, Manager roots, and direct sibling groups. Owned
  // descendants never inflate the ambient pill count.
  const workUnits = useMemo(
    () => deriveTopLevelActivityWorkUnits(tasks),
    [tasks],
  );
  const runningTasks = useMemo(
    () => workUnits.filter((unit) => unit.status === "running"),
    [workUnits],
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
  const workUnitsRef = useRef(workUnits);
  workUnitsRef.current = workUnits;

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
      // top-level units that were running, then revert to idle after the dwell.
      const statusById = new Map(
        workUnitsRef.current.map((unit) => [unit.id, unit.status]),
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
  const [inputValue, setInputValue] = useState(query);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep typing on the input's tiny local state and only wake the full
  // activity/files search tree after a short pause. `useDeferredValue` gives
  // React room to paint the final keystroke before reconciling the results.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      displaySearchStore.setQuery(inputValue);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  // While searching, the body becomes a fixed-height, internally-scrolling
  // box (see CSS) so the OUTER popover height stays constant no matter how
  // many results match — the results scroll inside a stable frame instead of
  // re-flowing the popover per keystroke. The layout is held on the immediate
  // input OR the still-deferred query so it engages before the first result
  // and collapses only once, after the field clears and results reconcile.
  const searching = shouldTrayHoldSearchLayout(inputValue, deferredQuery);

  return (
    <div
      className="composer-activity-tray"
      data-searching={searching || undefined}
    >
      <div className="composer-activity-tray__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          className="composer-activity-tray__search-input"
          value={inputValue}
          placeholder="Search activity, files, and more"
          onChange={(event) => setInputValue(event.currentTarget.value)}
          aria-label="Search activity, files, and more"
        />
      </div>
      <div className="composer-activity-tray__body">
        <LeftSidebarSections
          query={deferredQuery}
          variant="overview"
          onNavigate={onNavigate}
          renderEmpty={() => (
            <div className="composer-activity-tray__empty">
              {deferredQuery.trim()
                ? "Nothing matches that search."
                : "Activity will show up here as Stella works."}
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** The pill + searchable activity tray. */
const ActivityPillBody = memo(function ActivityPillBody({
  state,
  runningCount,
  open,
  onOpenChange,
}: {
  state: PillState;
  runningCount: number;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const label = getActivityPillLabel(state, runningCount);

  const labelNode: ReactNode =
    state === "running" ? (
      <TextShimmer
        text={label}
        durationMs={TITLE_SHIMMER_MS}
        exclusiveGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
        exclusivePriority={30}
      />
    ) : (
      label
    );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
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
        <ActivityTray onNavigate={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  );
});

export const ComposerActivityPill = memo(function ComposerActivityPill() {
  const panelOpen = useDisplayPanelOpen();
  const activeSection = useActiveSidebarSection();
  const reduceMotion = useReducedMotion();
  const chat = useChatRuntime();
  const tasks = chat.conversation.tasks;

  const { state, runningCount } = useActivityPillState(tasks);
  const displayedState = getDisplayedActivityPillState(
    state,
    panelOpen && activeSection === "tasks",
  );

  const [open, setOpen] = useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) displaySearchStore.clear();
  };

  return (
    <motion.div
      className="composer-activity-pill-slot"
      initial={{ opacity: 0, x: -8, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: 0.26, ease: "easeOut" }
      }
    >
      <ActivityPillBody
        state={displayedState}
        runningCount={runningCount}
        open={open}
        onOpenChange={handleOpenChange}
      />
    </motion.div>
  );
});
