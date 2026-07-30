/**
 * Composer activity pill — the compact presentation of background work that
 * sits in the context chip row above the composer.
 *
 * It renders only when Activity exists but its standalone surface is hidden:
 * while the right sidebar replaces Activity, or when the shell automatically
 * hides Activity at narrower widths.
 *
 * The pill does double duty:
 *   • Idle, it's the entry point to the Activity tray.
 *   • While Stella has background work in flight it shows a simple,
 *     shimmering count of how many top-level work units are running ("1 task in progress",
 *     "2 tasks in progress", …) — the per-task detail lives in the inline
 *     chat cards and the Tasks section, so the ambient pill just tallies. When
 *     work settles it briefly shows a finished / couldn't-finish / stopped
 *     state before quietly reverting to "Activity" — a minimum dwell so a quick
 *     task doesn't just flash its progress.
 *
 * Clicking it (in any state) opens the Activity tray. Search lives
 * permanently in the sidebar's unified Work tab.
 */
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, Check, LayoutList } from "@/ui/icons";
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
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { useShellBreakpointState } from "@/shell/shell-breakpoints";
import "./composer-activity-pill.css";

// Keep the full Activity hierarchy off the composer's eager module graph.
// The standalone surface already loads it lazily, and the tray only needs it
// after the user opens the popover.
const ActivityOverview = lazy(() =>
  import("@/shell/sidebar-sections/HomeSection").then((module) => ({
    default: module.ActivityOverview,
  })),
);

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
  if (state === "idle") return "Activity";
  if (state === "running") {
    return `${runningCount} ${runningCount === 1 ? "task" : "tasks"} in progress`;
  }
  return STATUS_FALLBACK[state];
};

export const shouldShowActivityPill = (
  hasActivity: boolean,
  panelOpen: boolean,
  workspaceStripHidden: boolean,
): boolean => hasActivity && (panelOpen || workspaceStripHidden);

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
      return <LayoutList size={15} strokeWidth={1.75} aria-hidden="true" />;
  }
}

function ActivityTray({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="composer-activity-tray">
      <Suspense fallback={null}>
        <ActivityOverview onNavigate={onNavigate} showModels={false} />
      </Suspense>
    </div>
  );
}

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
          aria-label={
            state === "idle" ? "Activity" : `${label} — open activity`
          }
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
  const shellBreakpoints = useShellBreakpointState();
  const reduceMotion = useReducedMotion();
  const chat = useChatRuntime();
  const tasks = chat.conversation.tasks;

  const { state, runningCount } = useActivityPillState(tasks);
  const visible = shouldShowActivityPill(
    tasks.length > 0,
    panelOpen,
    shellBreakpoints.hideWorkspaceStrip,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [open, visible]);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="composer-activity-pill"
          className="composer-activity-pill-slot"
          initial={{ opacity: 0, x: -8, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -8, scale: 0.96 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.18, ease: [0.32, 0.72, 0, 1] }
          }
        >
          <ActivityPillBody
            state={state}
            runningCount={runningCount}
            open={open}
            onOpenChange={setOpen}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
});
