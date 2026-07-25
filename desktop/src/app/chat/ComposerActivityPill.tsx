/**
 * Composer activity pill — the compact presentation of background work that
 * sits in the context chip row above the composer.
 *
 * It stays visible whatever the right sidebar is doing, so search is always
 * one click away from the composer. While the sidebar is open on Tasks, that
 * section owns live progress and the pill stays in its Search state.
 *
 * The pill does double duty:
 *   • Idle, it's the entry point to search — a search icon + "Search".
 *   • While Stella has background work in flight it shows a simple,
 *     shimmering count of how many top-level work units are running ("1 task in progress",
 *     "2 tasks in progress", …) — the per-task detail lives in the inline
 *     chat cards and the Tasks section, so the ambient pill just tallies. When
 *     work settles it briefly shows a finished / couldn't-finish / stopped
 *     state before quietly reverting to "Search" — a minimum dwell so a quick
 *     task doesn't just flash its progress.
 *
 * Clicking it (in any state) opens the sidebar's Search section, which owns
 * the query field and the searchable overview.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertCircle, Check, Search } from "@/ui/icons";
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
  sidebarSections,
  useActiveSidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
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
 * once.
 */
export const getDisplayedActivityPillState = (
  state: PillState,
  tasksSurfaceVisible: boolean,
): PillState => (tasksSurfaceVisible && state === "running" ? "idle" : state);

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

const ActivityPillBody = memo(function ActivityPillBody({
  state,
  runningCount,
  open,
}: {
  state: PillState;
  runningCount: number;
  /** Whether the sidebar is already showing the Search section. */
  open: boolean;
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
    <button
      type="button"
      className="composer-activity-pill"
      data-state={state}
      data-open={open || undefined}
      // `openLocation` rather than `selectSection`: the pill is an entry
      // point, so clicking it while Search is already showing must reveal the
      // field again, not close the panel out from under a live query.
      onClick={() => sidebarSections.openLocation("search", null)}
      aria-label={state === "idle" ? "Search" : `${label} — open search`}
    >
      <span className="composer-activity-pill__glyph" aria-hidden="true">
        <PillGlyph state={state} />
      </span>
      <span className="composer-activity-pill__label">{labelNode}</span>
    </button>
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
        open={panelOpen && activeSection === "search"}
      />
    </motion.div>
  );
});
