/**
 * Activity / Files / Schedule / Store sections rendered inside the left
 * sidebar. With `query` supplied they act as the searchable group overview;
 * section rows open the right sidebar viewer (master-detail).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { History, CheckCircle2, Circle, CircleDot, AlertCircle, ChevronDown } from "@/ui/icons";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import {
  useConversationSchedules,
  type ScheduleEntry,
} from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { matchesQuery } from "@/features/workspace-display/display-search-store";
import {
  loadOlderFeatureEntries,
  refreshFeatureSnapshot,
  useStoreSidePanelState,
} from "@/features/store/store-side-panel-store";
import { openStoreDisplayTab } from "@/shell/display/default-tabs";
import {
  sectionCollapseStore,
  useSectionCollapsed,
} from "@/shell/section-collapse-store";
import {
  EMPTY_FIRST_SEEN_ORDER,
  extractTasksFromActivities,
  getTaskDisplayText,
  getTaskGroupStatusText,
  groupActivityTasks,
  mergeFooterTasks,
  orderByFirstSeen,
  pruneGroupExpandOverrides,
  shouldShowTaskReasoningSummaries,
  updateSeenRunningGroupKeys,
  updateSeenRunningTaskIds,
  type ActivityRow,
  type FirstSeenOrder,
  type TaskGroup,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
  mergeAgentFileEvents,
} from "@/features/workspace-display/agent-files";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";
import {
  ActivityHistoryDialog,
  type ActivityHistorySection,
} from "@/shell/display/ActivityHistoryDialog";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "../../../runtime/kernel/shared/scheduling";
import { useAgentSessionStartedAt } from "@/features/chat/hooks/use-agent-session-started-at";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { AgentProgressSummaries } from "@/shell/AgentProgressSummaries";
import { useAgentProgressSummaries } from "@/features/chat/agent-progress-summary-store";
import "@/app/chat/chat-workspace-strip.css";

// Default per-section caps. The compact strip shows a small preview; the
// group overview shows more. An active search ignores caps entirely
// (see `caps` below) and pages in the full dataset.
const SECTION_CAPS = {
  strip: { activity: 8, files: 5, schedule: 4, store: 5 },
  overview: { activity: 6, files: 6, schedule: 6, store: 6 },
} as const;
const UNCAPPED = {
  activity: Infinity,
  files: Infinity,
  schedule: Infinity,
  store: Infinity,
};
const EMPTY_TASKS: TaskItem[] = [];
const EMPTY_FILES: ReadonlyArray<ConversationFileEntry> = [];
/** Most-recent reasoning summaries shown under an expanded agent. */
const AGENT_SUMMARY_CAP = 3;
/** File rows shown under an expanded agent before "View all (N)" kicks in. */
const AGENT_FILE_CAP = 5;

const activityRowText = (row: ActivityRow): string =>
  row.kind === "task"
    ? getTaskDisplayText(row.task) || row.task.description
    : row.group.label;

// ── Row enter / exit / reorder motion ───────────────────────────────
//
// Mirrors the 10px `gap` on `.chat-workspace-strip__list--tasks`: entering
// and exiting rows animate a matching negative top margin alongside their
// height so the flex gap they occupy opens and closes with them — otherwise
// the list snaps by one gap width the instant the row unmounts.
const LIST_GAP_PX = 10;

const ROW_HIDDEN = { height: 0, opacity: 0, marginTop: -LIST_GAP_PX };

// Enter: the space opens first (height spring), then the row fades in.
const ROW_ENTER = {
  height: "auto",
  opacity: 1,
  marginTop: 0,
  transition: {
    height: { type: "spring", duration: 0.32, bounce: 0 },
    marginTop: { type: "spring", duration: 0.32, bounce: 0 },
    opacity: { duration: 0.2, delay: 0.1, ease: "easeOut" },
  },
} as const;

// Exit: the fade leads, then the space closes behind it.
const ROW_EXIT = {
  height: 0,
  opacity: 0,
  marginTop: -LIST_GAP_PX,
  transition: {
    height: { type: "spring", duration: 0.28, bounce: 0, delay: 0.05 },
    marginTop: { type: "spring", duration: 0.28, bounce: 0, delay: 0.05 },
    opacity: { duration: 0.14, ease: "easeOut" },
  },
} as const;

// Reorders (running → done, resorts) FLIP the row to its new slot.
const ROW_REORDER_TRANSITION = {
  type: "spring",
  duration: 0.32,
  bounce: 0,
} as const;

const ROW_EXIT_INSTANT = { ...ROW_HIDDEN, transition: { duration: 0 } };

/**
 * Shared motion props for activity rows. `layout="position"` FLIPs reorders
 * with compositor-only transforms; `layoutDependency` pins measurement to the
 * row's list index so streamed content deltas (which re-render rows without
 * moving them) never force per-row layout reads. Reduced motion renders
 * every state instantly.
 */
const useActivityRowMotionProps = (orderIndex: number) => {
  const reduceMotion = useReducedMotion();
  return {
    layout: reduceMotion ? (false as const) : ("position" as const),
    layoutDependency: orderIndex,
    initial: reduceMotion ? false : ROW_HIDDEN,
    animate: ROW_ENTER,
    exit: reduceMotion ? ROW_EXIT_INSTANT : ROW_EXIT,
    transition: ROW_REORDER_TRANSITION,
  };
};

function WorkspaceSection({
  title,
  sectionId,
  children,
  onOpenHistory,
  historyLabel,
}: {
  title: string;
  /** Stable id for persisted collapse state. */
  sectionId: string;
  children?: ReactNode;
  onOpenHistory?: () => void;
  historyLabel?: string;
}) {
  const collapsed = useSectionCollapsed(sectionId);
  return (
    <section className="chat-workspace-strip__section">
      <header className="chat-workspace-strip__section-header">
        <button
          type="button"
          className="chat-workspace-strip__section-toggle"
          onClick={() => sectionCollapseStore.toggle(sectionId)}
          aria-expanded={!collapsed}
        >
          {title}
        </button>
        {onOpenHistory ? (
          <button
            type="button"
            className="chat-workspace-strip__section-history"
            onClick={onOpenHistory}
            aria-label={historyLabel ?? `View ${title} history`}
            title={historyLabel ?? `View ${title} history`}
          >
            <History size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div
        className="chat-workspace-strip__section-collapse"
        data-collapsed={collapsed ? "true" : undefined}
      >
        <div className="chat-workspace-strip__section-body">{children}</div>
      </div>
    </section>
  );
}

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    // Running rows carry a static "active" status dot (a ringed center dot)
    // rather than a spinner — the label's text shimmer already conveys the
    // working state, so this fills the reserved icon slot for alignment and
    // reads as "this thread is live" without a second animation.
    case "running":
      return (
        <CircleDot
          className="chat-workspace-strip__task-icon chat-workspace-strip__task-icon--running"
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <CheckCircle2
          className="chat-workspace-strip__task-icon chat-workspace-strip__task-icon--done"
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case "error":
      return (
        <AlertCircle
          className="chat-workspace-strip__task-icon chat-workspace-strip__task-icon--error"
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case "canceled":
      return (
        <Circle
          className="chat-workspace-strip__task-icon chat-workspace-strip__task-icon--canceled"
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      );
  }
}

const TaskRow = memo(function TaskRow({
  task,
  expanded,
  onToggle,
  files,
  onOpenFile,
  orderIndex,
}: {
  task: TaskItem;
  expanded: boolean;
  onToggle: (taskId: string, nextExpanded: boolean) => void;
  files: ReadonlyArray<ConversationFileEntry>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  /** Position in the host list; drives reorder FLIP measurement. */
  orderIndex: number;
}) {
  const motionProps = useActivityRowMotionProps(orderIndex);
  const label = (getTaskDisplayText(task) || task.description).trim();
  const summaries = useAgentProgressSummaries(task.id);
  // Per-session only; resets when the row unmounts, which is fine.
  const [showAllFiles, setShowAllFiles] = useState(false);
  // Summaries narrate live work — display them only while the agent is
  // active. They stay accumulated in the store, so a send_input
  // re-activation brings them straight back; a finished row shows files
  // only.
  const hasSummaries =
    summaries.length > 0 && shouldShowTaskReasoningSummaries(task);
  const hasFiles = files.length > 0;
  const filesCapped = files.length > AGENT_FILE_CAP;
  const visibleFiles =
    filesCapped && !showAllFiles ? files.slice(0, AGENT_FILE_CAP) : files;
  const hasDetail = hasSummaries || hasFiles;
  const detailOpen = expanded && hasDetail;
  return (
    <motion.li
      {...motionProps}
      className="chat-workspace-strip__task-row"
      data-status={task.status}
      data-expanded={expanded ? "true" : undefined}
      title={label}
    >
      <div className="chat-workspace-strip__task-row-head">
        <button
          type="button"
          className="chat-workspace-strip__task-button"
          onClick={() => onToggle(task.id, !expanded)}
          aria-expanded={expanded}
          aria-label={`${label || "Activity"} — ${
            expanded ? "collapse" : "expand"
          }`}
        >
          <span
            className="chat-workspace-strip__task-icon-wrap"
            aria-hidden="true"
          >
            <TaskStatusIcon status={task.status} />
          </span>
          <span className="chat-workspace-strip__task-label">
            {task.status === "running" ? (
              <TextShimmer text={label} durationMs={2000} />
            ) : (
              label
            )}
          </span>
        </button>
      </div>
      {/* Always mounted so both the user toggle and the first summary/file
          arriving animate open — grid-rows 0fr↔1fr, same pattern as the
          section header collapse. `inert` keeps the hidden detail out of the
          tab order and the accessibility tree while it stays in the DOM. */}
      <div
        className="chat-workspace-strip__task-collapse"
        data-collapsed={detailOpen ? undefined : "true"}
        inert={!detailOpen}
      >
        <div className="chat-workspace-strip__task-collapse-clip">
          {hasDetail ? (
            <div className="chat-workspace-strip__task-detail">
              {hasSummaries ? (
                <AgentProgressSummaries
                  agentId={task.id}
                  max={AGENT_SUMMARY_CAP}
                />
              ) : null}
          {hasFiles ? (
            <ul className="chat-workspace-strip__list chat-workspace-strip__task-files">
              {visibleFiles.map((file) => (
                <li
                  key={file.path}
                  className="chat-workspace-strip__row"
                  title={file.path}
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => onOpenFile(file)}
                  >
                    <DisplayTabIcon
                      kind={displayTabKindForPayload(file.payload)}
                      size={15}
                    />
                    <span className="chat-workspace-strip__file-name">
                      {basenameOf(file.path)}
                    </span>
                  </button>
                </li>
              ))}
              {filesCapped ? (
                <li className="chat-workspace-strip__row">
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button chat-workspace-strip__files-toggle"
                    onClick={() => setShowAllFiles((value) => !value)}
                    aria-expanded={showAllFiles}
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="chat-workspace-strip__files-toggle-chevron"
                      data-expanded={showAllFiles ? "true" : undefined}
                    />
                    <span className="chat-workspace-strip__file-name">
                      {showAllFiles ? "Show less" : `View all (${files.length})`}
                    </span>
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
});

const GroupRow = memo(function GroupRow({
  group,
  expanded,
  onToggle,
  isTaskExpanded,
  onToggleTask,
  agentFiles,
  onOpenFile,
  orderIndex,
}: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: (groupKey: string, nextExpanded: boolean) => void;
  isTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  /** Position in the host list; drives reorder FLIP measurement. */
  orderIndex: number;
}) {
  const motionProps = useActivityRowMotionProps(orderIndex);
  const label = group.label.trim();
  const statusText = getTaskGroupStatusText(group);
  return (
    <motion.li
      {...motionProps}
      className="chat-workspace-strip__task-row chat-workspace-strip__group-row"
      data-status={group.status}
      title={`${label} — ${statusText}`}
    >
      <button
        type="button"
        className="chat-workspace-strip__task-button"
        onClick={() => onToggle(group.groupKey, !expanded)}
        aria-expanded={expanded}
        aria-label={`${label || "Task group"}: ${statusText}`}
      >
        <span
          className="chat-workspace-strip__task-icon-wrap"
          aria-hidden="true"
        >
          <TaskStatusIcon status={group.status} />
        </span>
        <span className="chat-workspace-strip__task-label">
          {group.status === "running" ? (
            <TextShimmer text={label} durationMs={2000} />
          ) : (
            label
          )}
        </span>
        <span className="chat-workspace-strip__row-meta chat-workspace-strip__group-status">
          {statusText}
        </span>
      </button>
      {/* Always mounted so expand/collapse animates (grid-rows 0fr↔1fr). */}
      <div
        className="chat-workspace-strip__task-collapse"
        data-collapsed={expanded ? undefined : "true"}
        inert={!expanded}
      >
        <div className="chat-workspace-strip__task-collapse-clip">
          <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks chat-workspace-strip__group-members">
            <AnimatePresence initial={false}>
              {group.members.map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  expanded={isTaskExpanded(task)}
                  onToggle={onToggleTask}
                  files={agentFiles.get(task.id) ?? EMPTY_FILES}
                  onOpenFile={onOpenFile}
                  orderIndex={index}
                />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </div>
    </motion.li>
  );
});

const TasksList = memo(function TasksList({
  rows,
  isTaskExpanded,
  onToggleTask,
  isGroupExpanded,
  onToggleGroup,
  agentFiles,
  onOpenFile,
}: {
  rows: ReadonlyArray<ActivityRow>;
  isTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  isGroupExpanded: (group: TaskGroup) => boolean;
  onToggleGroup: (groupKey: string, nextExpanded: boolean) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
}) {
  return (
    <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks">
      {/* `initial={false}` keeps the first paint of an already-populated
          list static — only rows that appear/leave/move afterwards animate. */}
      <AnimatePresence initial={false}>
        {rows.map((row, index) =>
          row.kind === "task" ? (
            <TaskRow
              key={row.task.id}
              task={row.task}
              expanded={isTaskExpanded(row.task)}
              onToggle={onToggleTask}
              files={agentFiles.get(row.task.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
              orderIndex={index}
            />
          ) : (
            <GroupRow
              key={`group:${row.group.groupKey}`}
              group={row.group}
              expanded={isGroupExpanded(row.group)}
              onToggle={onToggleGroup}
              isTaskExpanded={isTaskExpanded}
              onToggleTask={onToggleTask}
              agentFiles={agentFiles}
              onOpenFile={onOpenFile}
              orderIndex={index}
            />
          ),
        )}
      </AnimatePresence>
    </ul>
  );
});

const activityRowStatus = (row: ActivityRow): TaskItem["status"] =>
  row.kind === "task" ? row.task.status : row.group.status;

const activityRowId = (row: ActivityRow): string =>
  row.kind === "task" ? row.task.id : row.group.groupKey;

const activityRowCompletedAtMs = (row: ActivityRow): number => {
  const entry = row.kind === "task" ? row.task : row.group;
  return entry.completedAtMs ?? entry.lastUpdatedAtMs ?? entry.startedAtMs;
};

const scheduleEntryToAffectedRef = (
  entry: ScheduleEntry,
  conversationId: string,
): ScheduleToolAffectedRef => ({
  kind: entry.kind,
  id: entry.id,
  conversationId,
  name: entry.name,
  enabled: entry.enabled,
  nextRunAtMs: entry.nextRunAtMs,
});

// Memoized: the host sidebar re-renders whenever root chrome state changes
// (e.g. the collapse toggle flipping its className on the animation's first
// frame), and re-reconciling this whole subtree there adds a hitch right as
// the width slide starts. Context-driven updates (chat runtime, stores)
// still re-render as usual.
export const LeftSidebarSections = memo(function LeftSidebarSections({
  query = "",
  variant = "strip",
  renderEmpty,
  onNavigate,
}: {
  /** When set, live-filters every section by this query (group overview). */
  query?: string;
  /** Default cap set: compact strip vs. roomier group overview. */
  variant?: "strip" | "overview";
  /** Rendered when nothing matches; strip mode omits it and renders null. */
  renderEmpty?: () => ReactNode;
  /** Fired after a section item is opened/selected — lets a host surface
   *  dismiss itself. */
  onNavigate?: () => void;
} = {}) {
  const chat = useChatRuntime();
  const { state } = useUiState();

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;
  const filesFeed = chat.conversation.files;
  const schedules = useConversationSchedules(conversationId);
  const storeState = useStoreSidePanelState();

  const searching = query.trim().length > 0;
  const caps = searching ? UNCAPPED : SECTION_CAPS[variant];

  useEffect(() => {
    void refreshFeatureSnapshot();
  }, []);

  // While searching, page in the full dataset so the query matches every
  // item, not just what's already loaded. Each loader call updates
  // hasOlder/loading, which re-runs the effect until the feed is drained.
  useEffect(() => {
    if (!searching) return;
    if (activity.hasOlder && !activity.isLoadingOlder) activity.loadOlder();
  }, [
    searching,
    activity.hasOlder,
    activity.isLoadingOlder,
    activity.loadOlder,
  ]);

  useEffect(() => {
    if (!searching) return;
    if (filesFeed.hasOlder && !filesFeed.isLoadingOlder) filesFeed.loadOlder();
  }, [
    searching,
    filesFeed.hasOlder,
    filesFeed.isLoadingOlder,
    filesFeed.loadOlder,
  ]);

  useEffect(() => {
    if (!searching) return;
    const total = storeState.rosterTotal;
    if (total == null || storeState.olderLoading) return;
    const loaded =
      (storeState.snapshot?.items.length ?? 0) + storeState.olderEntries.length;
    if (loaded < total) void loadOlderFeatureEntries();
  }, [
    searching,
    storeState.rosterTotal,
    storeState.olderLoading,
    storeState.snapshot,
    storeState.olderEntries.length,
  ]);
  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);
  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);
  // Ids/group-keys seen running this session — the sticky half of the
  // expansion defaults below (rolled forward next to `allTasks`).
  const seenRunningTasksRef = useRef<ReadonlySet<string>>(new Set());
  const seenRunningGroupsRef = useRef<ReadonlySet<string>>(new Set());
  // Group expand/collapse mirrors the per-task semantics below: a running
  // group comes up expanded (its members are live) and STAYS expanded once
  // it finishes (seen-running set), so completion never yanks the group's
  // work out of view. `groupExpandOverrides` records explicit user toggles,
  // which win over the status default and are never stomped by it.
  const [groupExpandOverrides, setGroupExpandOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isGroupExpanded = useCallback(
    (group: TaskGroup): boolean =>
      groupExpandOverrides.get(group.groupKey) ??
      (group.status === "running" ||
        seenRunningGroupsRef.current.has(group.groupKey)),
    [groupExpandOverrides],
  );
  const toggleGroup = useCallback(
    (groupKey: string, nextExpanded: boolean) => {
      setGroupExpandOverrides((prev) => {
        const next = new Map(prev);
        next.set(groupKey, nextExpanded);
        return next;
      });
    },
    [],
  );
  // Per-agent expand/collapse: an expanded activity row reveals that
  // agent's recent reasoning summaries and the files it produced.
  //
  // Default state: a running agent comes up expanded (freshly-started agents
  // auto-expand), and an agent seen running THIS session stays expanded
  // after it finishes — completion must not collapse the row and hide the
  // work the user was just watching (prod bug: finish → auto-collapse →
  // detail gone). Rows loaded already-completed (history, conversation
  // switch) default collapsed as before, since their ids were never seen
  // running. `expandOverrides` records rows the user has explicitly toggled;
  // those win over every default and are never stomped by it.
  const [expandOverrides, setExpandOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isTaskExpanded = useCallback(
    (task: TaskItem): boolean => {
      const override = expandOverrides.get(task.id);
      return (
        override ??
        (task.status === "running" ||
          seenRunningTasksRef.current.has(task.id))
      );
    },
    [expandOverrides],
  );
  const toggleTask = useCallback((taskId: string, nextExpanded: boolean) => {
    setExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(taskId, nextExpanded);
      return next;
    });
  }, []);

  const allTasks = useMemo(() => {
    const persisted = extractTasksFromActivities(activity.activities, {
      appSessionStartedAtMs,
      latestMessageTimestampMs: activity.latestMessageTimestampMs,
    });
    return mergeFooterTasks(persisted, liveTasks);
  }, [
    activity.activities,
    activity.latestMessageTimestampMs,
    appSessionStartedAtMs,
    liveTasks,
  ]);

  // Roll the seen-running sets forward in a memo (same idempotent-mutation
  // pattern as `runningOrderRef`) so they're current before any row computes
  // its expansion; pruned to ids still present in the task list so they
  // can't grow unboundedly.
  useMemo(() => {
    seenRunningTasksRef.current = updateSeenRunningTaskIds(
      seenRunningTasksRef.current,
      allTasks,
    );
    seenRunningGroupsRef.current = updateSeenRunningGroupKeys(
      seenRunningGroupsRef.current,
      allTasks,
    );
  }, [allTasks]);

  const groupedRows = useMemo(() => groupActivityTasks(allTasks), [allTasks]);

  // Drop overrides for groups with no remaining member in the task list
  // (aged out of the activity window / conversation switch) so the map can't
  // grow unboundedly across a long session. Keyed off the unfiltered tasks —
  // not the rendered rows — so a group that shrinks to a single member
  // (rendered as a plain task row) or is merely hidden by the sidebar search
  // keeps the user's explicit choice for when it regrows.
  useEffect(() => {
    setGroupExpandOverrides((prev) => pruneGroupExpandOverrides(prev, allTasks));
  }, [allTasks]);

  const activityRows = useMemo(() => {
    if (!query) return groupedRows;
    return groupedRows.filter((row) =>
      matchesQuery(activityRowText(row), query),
    );
  }, [groupedRows, query]);

  // Running agents are no longer filtered out — they list alongside finished
  // ones, newest at the top. Each row is pinned to a frozen index captured
  // the first time it showed up as running, then rendered newest-first
  // (descending index): a newly-started agent prepends at the top while the
  // existing running rows keep their relative order and shift down by one.
  // Sorting by a live field like `startedAtMs` instead re-shuffled the list,
  // because that value drifts forward once an agent's original `agent-started`
  // event ages out of the rolling activity window — so a still-running row
  // would climb on every streamed update. A row only leaves this list — and
  // moves into the done section — when it finishes or errors out.
  //
  // First-seen indices are assigned over the *unfiltered* running population
  // (`groupedRows`) and the sidebar search `query` is applied afterward, for
  // display only. Ordering the already-filtered `activityRows` instead pruned
  // running rows that didn't match the query from the frozen order map, so
  // clearing the search re-admitted them as newly-seen — reshuffling the
  // running list and jumping previously-hidden rows to the top.
  const runningOrderRef = useRef<FirstSeenOrder>(EMPTY_FIRST_SEEN_ORDER);
  const runningRows = useMemo(() => {
    const running = groupedRows.filter(
      (row) => activityRowStatus(row) === "running",
    );
    const { ordered, state } = orderByFirstSeen(
      running,
      activityRowId,
      runningOrderRef.current,
      true,
    );
    // Safe to mutate the ref inside useMemo: orderByFirstSeen is idempotent
    // for unchanged input, so a repeat run (e.g. StrictMode) yields the same
    // frozen indices.
    runningOrderRef.current = state;
    const visible = query
      ? ordered.filter((row) => matchesQuery(activityRowText(row), query))
      : ordered;
    // Never cap the running list — every active/running thread stays visible
    // regardless of the orchestrator's busy/idle state. While the orchestrator
    // is busy its in-flight run streams extra live running rows on top of the
    // persisted ones; slicing to `caps.activity` here silently dropped the
    // overflow active thread (running rows have no "View all" escape hatch),
    // and it reappeared only once the run finished and the live rows cleared.
    // Only the done rows are capped: `visibleDoneRows` takes whatever budget
    // the running rows leave, and they carry the "View all activity" affordance.
    return visible;
  }, [groupedRows, query]);

  const doneRows = useMemo(
    () =>
      [...activityRows]
        .filter((row) => activityRowStatus(row) !== "running")
        .sort(
          (a, b) =>
            activityRowCompletedAtMs(b) - activityRowCompletedAtMs(a) ||
            activityRowId(a).localeCompare(activityRowId(b)),
        ),
    [activityRows],
  );

  // Files produced by each agent, keyed by agentId, nested under that agent's
  // expanded row (replacing the old standalone Files section).
  //
  // Sourcing merges two feeds so files show up LIVE while an agent works:
  //  - `activity.activities` (lifecycle events) carries the
  //    `agent-completed` rollup — the only file source for engines that
  //    report changes on the turn result (e.g. claude-code agents).
  //  - `filesFeed.files` carries agent-attributed `tool_result` events as
  //    each tool finishes, so a native agent's files appear the moment
  //    they're written. The files store only refetches on file-bearing
  //    events, so this input is quiet during pure text streaming.
  // `mergeAgentFileEvents` dedupes overlap by event id; per-path dedupe in
  // `deriveConversationFiles` keeps live + rollup copies from double-listing.
  //
  // `activity.activities` gets a fresh array identity on every streamed delta
  // (the activity window is refetched per `localChat:updated`), so a plain
  // `useMemo([activity.activities])` re-ran the heavy per-agent file
  // derivation on every token — the 44ms sidebar offender in the trace. Gate
  // the recompute on a cheap content signature of the file-contributing
  // events so it only re-runs when an agent's files actually change; the
  // returned Map keeps a stable reference across deltas otherwise (so the
  // memoized task rows that take it as a prop also stop re-reconciling).
  const agentFileEvents = useMemo(
    () => mergeAgentFileEvents(activity.activities, filesFeed.files),
    [activity.activities, filesFeed.files],
  );
  const agentFilesCacheRef = useRef<{
    signature: string;
    result: Map<string, ConversationFileEntry[]>;
  } | null>(null);
  const agentFiles = useMemo(() => {
    const signature = agentFilesSignature(agentFileEvents);
    const cached = agentFilesCacheRef.current;
    if (cached && cached.signature === signature) return cached.result;
    const result = deriveAgentFilesMap(agentFileEvents);
    agentFilesCacheRef.current = { signature, result };
    return result;
  }, [agentFileEvents]);

  const filteredSchedules = useMemo(() => {
    if (!query) return schedules;
    return schedules.filter((entry) => matchesQuery(entry.name, query));
  }, [schedules, query]);

  const storeItems = useMemo(() => {
    const base = storeState.snapshot?.items ?? [];
    // Search reaches older roster entries too (paged in by the effect above);
    // the default view only lists the newest snapshot window.
    const source = searching ? [...base, ...storeState.olderEntries] : base;
    if (!query) return source;
    return source.filter((item) => matchesQuery(item.name, query));
  }, [storeState.snapshot, storeState.olderEntries, searching, query]);

  const nowMs = Date.now();

  const visibleDoneRows = useMemo(
    () => doneRows.slice(0, Math.max(0, caps.activity - runningRows.length)),
    [doneRows, caps.activity, runningRows.length],
  );
  const hiddenDoneCount = doneRows.length - visibleDoneRows.length;
  const visibleActivityRows = useMemo(
    () => [...runningRows, ...visibleDoneRows],
    [runningRows, visibleDoneRows],
  );
  const upNext = useMemo(
    () => filteredSchedules.slice(0, caps.schedule),
    [filteredSchedules, caps.schedule],
  );
  const hiddenScheduleCount = filteredSchedules.length - upNext.length;
  const storePreview = storeItems.slice(0, caps.store);
  const hiddenStoreCount = storeItems.length - storePreview.length;

  const hasActivity = visibleActivityRows.length > 0;
  const hasSchedule = upNext.length > 0;
  // Store is no longer listed by default — it only surfaces while searching.
  const hasStore = searching && storePreview.length > 0;
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, conversationId)];
  }, [conversationId, openScheduleEntry]);

  const handleOpenFile = useCallback(
    (entry: ConversationFileEntry) => {
      openDisplayPayloadTab(entry.payload);
      onNavigate?.();
    },
    [onNavigate],
  );

  if (!hasActivity && !hasSchedule && !hasStore) {
    return renderEmpty ? <>{renderEmpty()}</> : null;
  }

  return (
    <>
      <div className="chat-workspace-strip__panel">
        {hasActivity && (
          <WorkspaceSection
            title="Activity"
            sectionId="activity"
            onOpenHistory={
              hiddenDoneCount > 0 ? () => setHistorySection("done") : undefined
            }
            historyLabel={`View all activity (${doneRows.length})`}
          >
            <TasksList
              rows={visibleActivityRows}
              isTaskExpanded={isTaskExpanded}
              onToggleTask={toggleTask}
              isGroupExpanded={isGroupExpanded}
              onToggleGroup={toggleGroup}
              agentFiles={agentFiles}
              onOpenFile={handleOpenFile}
            />
          </WorkspaceSection>
        )}

        {hasSchedule && (
          <WorkspaceSection
            title="Schedule"
            sectionId="schedule"
            onOpenHistory={
              hiddenScheduleCount > 0
                ? () => setHistorySection("upNext")
                : undefined
            }
            historyLabel={`View all schedules (${schedules.length})`}
          >
            <ul className="chat-workspace-strip__list">
              {upNext.map((entry) => (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="chat-workspace-strip__row"
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => {
                      setOpenScheduleEntry(entry);
                      onNavigate?.();
                    }}
                  >
                    <span className="chat-workspace-strip__row-label">
                      {entry.name.trim()}
                    </span>
                    <span className="chat-workspace-strip__row-meta">
                      {formatNextRun(entry.nextRunAtMs, nowMs)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceSection>
        )}

        {hasStore && (
          <WorkspaceSection
            title="Store"
            sectionId="store"
            onOpenHistory={
              hiddenStoreCount > 0 ? () => openStoreDisplayTab() : undefined
            }
            historyLabel={`View all add-ons (${storeItems.length})`}
          >
            <ul className="chat-workspace-strip__list">
              {storePreview.map((item) => (
                <li
                  key={item.featureId ?? item.name}
                  className="chat-workspace-strip__row"
                  title={item.name}
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => {
                      openStoreDisplayTab();
                      onNavigate?.();
                    }}
                  >
                    <DisplayTabIcon kind="store" size={15} />
                    <span className="chat-workspace-strip__file-name">
                      {item.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceSection>
        )}
      </div>
      <ScheduleDetailsDialog
        open={openScheduleEntry !== null}
        onOpenChange={(next) => {
          if (!next) setOpenScheduleEntry(null);
        }}
        affected={dialogAffected}
      />
      <ActivityHistoryDialog
        open={historySection !== null}
        onOpenChange={(next) => {
          if (!next) setHistorySection(null);
        }}
        section={historySection ?? "done"}
        activities={activity.activities}
        latestMessageTimestampMs={activity.latestMessageTimestampMs}
        onLoadMoreActivity={activity.loadOlder}
        hasMoreActivity={activity.hasOlder}
        isLoadingMoreActivity={activity.isLoadingOlder}
        fileEvents={filesFeed.files}
        onLoadMoreFiles={filesFeed.loadOlder}
        hasMoreFiles={filesFeed.hasOlder}
        isLoadingMoreFiles={filesFeed.isLoadingOlder}
        schedules={schedules}
        conversationId={conversationId}
        nowMs={nowMs}
        onOpenSchedule={(entry) => {
          setOpenScheduleEntry(entry);
          setHistorySection(null);
        }}
        onOpenFile={(entry) => {
          handleOpenFile(entry);
          setHistorySection(null);
        }}
      />
    </>
  );
});
