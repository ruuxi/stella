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
  type CSSProperties,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronDown,
  Eye,
} from "@/ui/icons";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
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
  EMPTY_ACTIVITY_EXPANSION,
  activityExpansionStore,
} from "@/shell/activity-expansion-store";
import {
  EMPTY_FIRST_SEEN_ORDER,
  activityRowKey,
  flattenActivityTasks,
  getCompactActivityStatusText,
  getActivityRowCompletedAtMs,
  getActivityRowSearchText,
  getActivityRowStatus,
  groupActivityTasks,
  orderByFirstSeen,
  pruneGroupExpandOverrides,
  getTaskAgentUpdates,
  summarizeCompactActivity,
  updateSeenRunningTaskIds,
  type ActivityRow,
  type FirstSeenOrder,
  type TaskGroup,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { AGENT_IDS } from "../../../runtime/contracts/agent-runtime.js";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
  mergeAgentFileEvents,
} from "@/features/workspace-display/agent-files";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  openAgentThreadTab,
  openDisplayPayloadTab,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "../../../runtime/kernel/shared/scheduling";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { AgentAssistantUpdates } from "@/shell/AgentAssistantUpdates";
import { selectLatestAgentAssistantMessage } from "@/features/chat/lib/agent-assistant-summary";
import "@/app/chat/chat-workspace-strip.css";

// Default per-section caps. The compact strip shows a small preview; the
// group overview shows more. An active search ignores caps entirely
// (see `caps` below) and pages in the full dataset.
const SECTION_CAPS = {
  strip: { activity: 8, files: 5, schedule: 4, store: 5 },
  overview: { activity: 6, files: 6, schedule: 6, store: 6 },
} as const;
// Search still scans every loaded record, but rendering an unbounded match
// set made a common query mount hundreds of rows at once.
const SEARCH_CAPS = { activity: 40, files: 40, schedule: 30, store: 30 };
const EMPTY_FILES: ReadonlyArray<ConversationFileEntry> = [];
/** Most-recent agent-authored messages shown under an expanded agent. */
const AGENT_UPDATE_CAP = 3;
/** File rows shown under an expanded agent before "View all (N)" kicks in. */
const AGENT_FILE_CAP = 5;

const activityRowText = (row: ActivityRow): string =>
  getActivityRowSearchText(row);

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
}: {
  title: string;
  /** Stable id for persisted collapse state. */
  sectionId: string;
  children?: ReactNode;
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

const compactTaskState = (task: TaskItem): string => {
  switch (task.status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "error":
      return "failed";
    case "canceled":
      return "stopped";
  }
};

const compactTaskTooltip = (task: TaskItem): string => {
  const label = task.description.trim() || "Agent";
  const detail = (
    selectLatestAgentAssistantMessage(task.assistantMessages) ?? ""
  ).replace(/\s+/g, " ");
  const clipped = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  return `${label} · ${compactTaskState(task)}${clipped ? ` — ${clipped}` : ""}`;
};

const CompactChildState = memo(function CompactChildState({
  summary,
  prioritizeFailure,
}: {
  summary: ReturnType<typeof summarizeCompactActivity>;
  prioritizeFailure: boolean;
}) {
  const statusText = getCompactActivityStatusText(summary, prioritizeFailure);
  return (
    <>
      {summary.usesProgressBar ? (
        <span
          className="chat-workspace-strip__compact-progress"
          aria-hidden="true"
        >
          <span className="chat-workspace-strip__compact-bar">
            {summary.completedCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--done"
                style={{ flexGrow: summary.completedCount }}
              />
            ) : null}
            {summary.runningCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--running anim-pulse"
                style={{ flexGrow: summary.runningCount }}
              />
            ) : null}
            {summary.errorCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--error"
                style={{ flexGrow: summary.errorCount }}
              />
            ) : null}
            {summary.canceledCount > 0 ? (
              <span
                className="chat-workspace-strip__compact-bar-segment chat-workspace-strip__compact-bar-segment--queued"
                style={{ flexGrow: summary.canceledCount }}
              />
            ) : null}
          </span>
          <span className="chat-workspace-strip__compact-progress-count">
            {summary.completedCount}/{summary.totalCount}
          </span>
        </span>
      ) : (
        <span
          className="chat-workspace-strip__compact-cells"
          aria-hidden="true"
        >
          {summary.tasks.map((task, index) => (
            <span
              key={task.id}
              className={`chat-workspace-strip__compact-cell chat-workspace-strip__compact-cell--${task.status}${
                task.status === "running" ? " anim-pulse" : ""
              }`}
              // Staggers the mount fade/scale-in so a burst of freshly
              // spawned agents ripples in instead of popping as a block.
              style={{ "--cell-order": index } as CSSProperties}
              title={compactTaskTooltip(task)}
            />
          ))}
        </span>
      )}
      <span
        className="chat-workspace-strip__compact-status"
        data-failure={
          prioritizeFailure && summary.errorCount > 0 ? "true" : undefined
        }
      >
        {statusText}
      </span>
    </>
  );
});

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  const suffix =
    status === "completed" ? "done" : status === "error" ? "error" : status;
  return (
    <AgentLifecycleStatusIcon
      status={status}
      className={`chat-workspace-strip__task-icon chat-workspace-strip__task-icon--${suffix}`}
      size={15}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

const TaskRow = memo(function TaskRow({
  task,
  expanded,
  onToggle,
  onSelect,
  files,
  onOpenFile,
  orderIndex,
  metaText,
  childContent,
  compactChildren,
  compactFailurePriority = false,
}: {
  task: TaskItem;
  expanded: boolean;
  onToggle: (taskId: string, nextExpanded: boolean) => void;
  /** Open this exact agent thread in the read-only workspace chat. */
  onSelect: (task: TaskItem) => void;
  files: ReadonlyArray<ConversationFileEntry>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  /** Position in the host list; drives reorder FLIP measurement. */
  orderIndex: number;
  /** Stable supporting text, used by Manager ownership headers. */
  metaText?: string;
  /** Persisted child ownership hierarchy, rendered before files. */
  childContent?: ReactNode;
  /** Owned agents collapsed into the Manager's cell-grid summary. */
  compactChildren?: readonly ActivityRow[];
  /** Keep a child failure at the front while its Manager is still active. */
  compactFailurePriority?: boolean;
}) {
  const motionProps = useActivityRowMotionProps(orderIndex);
  // Sidebar and tray rows identify the delegated thread. Live tool state is
  // intentionally reserved for the inline chat card, so it cannot replace
  // the stable description here or leak into activity search.
  const label = task.description.trim();
  const agentUpdates = getTaskAgentUpdates(task);
  // Per-session only; resets when the row unmounts, which is fine.
  const [showAllFiles, setShowAllFiles] = useState(false);
  // Agent-authored assistant messages replace generated/tool-status summary
  // text and remain available after completion without extra inference.
  const hasAgentUpdates = agentUpdates.length > 0;
  const managerDetail =
    task.agentType === AGENT_IDS.MANAGER
      ? task.status === "running"
        ? task.statusText?.trim() &&
          task.statusText.trim() !== task.description.trim()
          ? task.statusText.trim()
          : undefined
        : task.outputPreview?.trim() || undefined
      : undefined;
  const hasFiles = files.length > 0;
  const filesCapped = files.length > AGENT_FILE_CAP;
  const visibleFiles =
    filesCapped && !showAllFiles ? files.slice(0, AGENT_FILE_CAP) : files;
  const compactTasks = useMemo(
    () => (compactChildren ? flattenActivityTasks(compactChildren) : undefined),
    [compactChildren],
  );
  const compactSummary = useMemo(
    () => (compactTasks ? summarizeCompactActivity(compactTasks) : undefined),
    [compactTasks],
  );
  const hasChildContent = Boolean(childContent);
  const hasDetail =
    hasChildContent || Boolean(managerDetail) || hasAgentUpdates || hasFiles;
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
          data-compact={compactSummary ? "true" : undefined}
          onClick={() => onToggle(task.id, !expanded)}
          aria-expanded={expanded}
          aria-label={`${label || "Activity"} — ${
            expanded ? "collapse" : "expand"
          }`}
        >
          {compactSummary ? (
            <>
              <span className="chat-workspace-strip__compact-main">
                <span
                  className="chat-workspace-strip__task-icon-wrap"
                  aria-hidden="true"
                >
                  <TaskStatusIcon status={task.status} />
                </span>
                <span className="chat-workspace-strip__task-label">
                  {task.status === "running" ? (
                    <TextShimmer text={label} durationMs={2000} syncPhase />
                  ) : (
                    label
                  )}
                </span>
              </span>
              <CompactChildState
                summary={compactSummary}
                prioritizeFailure={compactFailurePriority && !expanded}
              />
            </>
          ) : (
            <>
              <span
                className="chat-workspace-strip__task-icon-wrap"
                aria-hidden="true"
              >
                <TaskStatusIcon status={task.status} />
              </span>
              <span className="chat-workspace-strip__task-label">
                {task.status === "running" ? (
                  <TextShimmer text={label} durationMs={2000} syncPhase />
                ) : (
                  label
                )}
              </span>
              {metaText ? (
                <span className="chat-workspace-strip__row-meta chat-workspace-strip__group-status">
                  {metaText}
                </span>
              ) : null}
            </>
          )}
        </button>
        <button
          type="button"
          className="chat-workspace-strip__task-attach"
          onClick={() => onSelect(task)}
          aria-label="View activity"
          title="View activity"
        >
          <Eye size={14} strokeWidth={2} aria-hidden="true" />
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
              {managerDetail ? (
                <p className="chat-workspace-strip__manager-status">
                  {managerDetail}
                </p>
              ) : null}
              {hasAgentUpdates ? (
                <AgentAssistantUpdates
                  messages={agentUpdates}
                  max={AGENT_UPDATE_CAP}
                />
              ) : null}
              {childContent}
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
                          {showAllFiles
                            ? "Show less"
                            : `View all (${files.length})`}
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
  onSelectTask,
  agentFiles,
  onOpenFile,
  orderIndex,
}: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: (groupKey: string, nextExpanded: boolean) => void;
  isTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  onSelectTask: (task: TaskItem) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  /** Position in the host list; drives reorder FLIP measurement. */
  orderIndex: number;
}) {
  const motionProps = useActivityRowMotionProps(orderIndex);
  const label = group.label.trim();
  const compactSummary = useMemo(
    () => summarizeCompactActivity(group.members),
    [group.members],
  );
  const statusText = getCompactActivityStatusText(
    compactSummary,
    group.status === "running" && !expanded,
  );
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
        data-compact="true"
        onClick={() => onToggle(group.groupKey, !expanded)}
        aria-expanded={expanded}
        aria-label={`${label || "Task group"}: ${statusText}`}
      >
        <span className="chat-workspace-strip__compact-main">
          <span
            className="chat-workspace-strip__task-icon-wrap"
            aria-hidden="true"
          >
            <TaskStatusIcon status={group.status} />
          </span>
          <span className="chat-workspace-strip__task-label">
            {group.status === "running" ? (
              <TextShimmer text={label} durationMs={2000} syncPhase />
            ) : (
              label
            )}
          </span>
        </span>
        <CompactChildState
          summary={compactSummary}
          prioritizeFailure={group.status === "running" && !expanded}
        />
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
                  onSelect={onSelectTask}
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
  isCompactTaskExpanded,
  onToggleTask,
  onSelectTask,
  isGroupExpanded,
  onToggleGroup,
  agentFiles,
  onOpenFile,
  nested = false,
}: {
  rows: ReadonlyArray<ActivityRow>;
  isTaskExpanded: (task: TaskItem) => boolean;
  isCompactTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  onSelectTask: (task: TaskItem) => void;
  isGroupExpanded: (group: TaskGroup) => boolean;
  onToggleGroup: (groupKey: string, nextExpanded: boolean) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  nested?: boolean;
}) {
  return (
    <ul
      className={`chat-workspace-strip__list chat-workspace-strip__list--tasks${
        nested ? " chat-workspace-strip__group-members" : ""
      }`}
    >
      {/* `initial={false}` keeps the first paint of an already-populated
          list static — only rows that appear/leave/move afterwards animate. */}
      <AnimatePresence initial={false}>
        {rows.map((row, index) =>
          row.kind === "task" ? (
            <TaskRow
              key={activityRowKey(row)}
              task={row.task}
              expanded={isTaskExpanded(row.task)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              files={agentFiles.get(row.task.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
              orderIndex={index}
            />
          ) : row.kind === "group" ? (
            <GroupRow
              key={activityRowKey(row)}
              group={row.group}
              expanded={isGroupExpanded(row.group)}
              onToggle={onToggleGroup}
              isTaskExpanded={isTaskExpanded}
              onToggleTask={onToggleTask}
              onSelectTask={onSelectTask}
              agentFiles={agentFiles}
              onOpenFile={onOpenFile}
              orderIndex={index}
            />
          ) : (
            <TaskRow
              key={activityRowKey(row)}
              task={
                row.hierarchy.status === row.hierarchy.owner.status
                  ? row.hierarchy.owner
                  : { ...row.hierarchy.owner, status: row.hierarchy.status }
              }
              expanded={isCompactTaskExpanded(row.hierarchy.owner)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              files={agentFiles.get(row.hierarchy.owner.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
              orderIndex={index}
              compactChildren={row.hierarchy.children}
              compactFailurePriority={row.hierarchy.owner.status === "running"}
              childContent={
                <TasksList
                  rows={row.hierarchy.children}
                  isTaskExpanded={isTaskExpanded}
                  isCompactTaskExpanded={isCompactTaskExpanded}
                  onToggleTask={onToggleTask}
                  onSelectTask={onSelectTask}
                  isGroupExpanded={isGroupExpanded}
                  onToggleGroup={onToggleGroup}
                  agentFiles={agentFiles}
                  onOpenFile={onOpenFile}
                  nested
                />
              }
            />
          ),
        )}
      </AnimatePresence>
    </ul>
  );
});

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
  const allTasks = chat.conversation.tasks;
  const filesFeed = chat.conversation.files;
  const {
    hasOlder: activityHasOlder,
    isLoadingOlder: activityIsLoadingOlder,
    loadOlder: loadOlderActivity,
  } = activity;
  const {
    hasOlder: filesHaveOlder,
    isLoadingOlder: filesAreLoadingOlder,
    loadOlder: loadOlderFiles,
  } = filesFeed;
  const schedules = useConversationSchedules(conversationId);
  const storeState = useStoreSidePanelState();

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const caps = searching ? SEARCH_CAPS : SECTION_CAPS[variant];

  useEffect(() => {
    void refreshFeatureSnapshot();
  }, []);

  // While searching, page in the full dataset so the query matches every
  // item, not just what's already loaded. Each loader call updates
  // hasOlder/loading, which re-runs the effect until the feed is drained.
  useEffect(() => {
    if (!searching) return;
    if (activityHasOlder && !activityIsLoadingOlder) loadOlderActivity();
  }, [searching, activityHasOlder, activityIsLoadingOlder, loadOlderActivity]);

  useEffect(() => {
    if (!searching) return;
    if (filesHaveOlder && !filesAreLoadingOlder) loadOlderFiles();
  }, [searching, filesHaveOlder, filesAreLoadingOlder, loadOlderFiles]);

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
  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);
  // Ids seen running this session — the sticky half of regular task-row
  // expansion defaults below (rolled forward next to `allTasks`).
  const seenRunningTasksRef = useRef<ReadonlySet<string>>(new Set());
  // Compact groups are collapsed by default, including while running.
  // Explicit user toggles are persisted and always win.
  const [groupExpandOverrides, setGroupExpandOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isGroupExpanded = useCallback(
    (group: TaskGroup): boolean =>
      groupExpandOverrides.get(group.groupKey) ?? false,
    [groupExpandOverrides],
  );
  const toggleGroup = useCallback((groupKey: string, nextExpanded: boolean) => {
    setGroupExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(groupKey, nextExpanded);
      return next;
    });
  }, []);
  // Per-agent expand/collapse: an expanded activity row reveals that
  // agent's recent assistant messages and the files it produced.
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
        (task.status === "running" || seenRunningTasksRef.current.has(task.id))
      );
    },
    [expandOverrides],
  );
  const isCompactTaskExpanded = useCallback(
    (task: TaskItem): boolean => expandOverrides.get(task.id) ?? false,
    [expandOverrides],
  );
  const toggleTask = useCallback((taskId: string, nextExpanded: boolean) => {
    setExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(taskId, nextExpanded);
      return next;
    });
  }, []);

  // Re-seed every piece of expansion state from the persisted store whenever
  // the active conversation changes (including first mount). Without this, a
  // relaunch loads every task as "already completed, never seen running" and
  // collapses rows that were open — with their files visible — moments before
  // quitting. Render-phase reset (the sanctioned derived-state pattern) so
  // seeded values are in place before the roll-forward memo below runs.
  const [seededConversationId, setSeededConversationId] = useState<
    string | null | undefined
  >(undefined);
  if (seededConversationId !== conversationId) {
    setSeededConversationId(conversationId);
    const snapshot = conversationId
      ? activityExpansionStore.load(conversationId)
      : EMPTY_ACTIVITY_EXPANSION;
    seenRunningTasksRef.current = new Set(snapshot.seenTaskIds);
    setExpandOverrides(new Map(Object.entries(snapshot.taskOverrides)));
    setGroupExpandOverrides(new Map(Object.entries(snapshot.groupOverrides)));
  }

  // Roll the seen-running sets forward in a memo (same idempotent-mutation
  // pattern as `runningOrderRef`) so they're current before any row computes
  // its expansion; pruned to ids still present in the task list so they
  // can't grow unboundedly.
  useMemo(() => {
    // An empty list usually means the activity feed hasn't loaded yet (cold
    // start / conversation switch) — pruning against it would wipe the
    // persisted seen-running state we just seeded, so wait for real data.
    if (allTasks.length === 0) return;
    seenRunningTasksRef.current = updateSeenRunningTaskIds(
      seenRunningTasksRef.current,
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
    if (allTasks.length === 0) return;
    setGroupExpandOverrides((prev) =>
      pruneGroupExpandOverrides(prev, allTasks),
    );
  }, [allTasks]);

  // Persist the expansion state so a relaunch (which restores this
  // conversation) brings the Activity rows back exactly as they looked —
  // a finished agent's row keeps showing its files across restarts, not just
  // across completions. Runs after the roll-forward memo above, so the saved
  // sets are already pruned to the current activity window. Skipped while the
  // task list is empty for the same cold-start reason as the pruning guards.
  useEffect(() => {
    if (!conversationId || allTasks.length === 0) return;
    activityExpansionStore.save(conversationId, {
      seenTaskIds: [...seenRunningTasksRef.current],
      taskOverrides: Object.fromEntries(expandOverrides),
      groupOverrides: Object.fromEntries(groupExpandOverrides),
    });
  }, [conversationId, allTasks, expandOverrides, groupExpandOverrides]);

  const matchingActivityKeys = useMemo(() => {
    if (!searching) return null;
    const keys = new Set<string>();
    for (const row of groupedRows) {
      if (activityRowText(row).toLowerCase().includes(normalizedQuery)) {
        keys.add(activityRowKey(row));
      }
    }
    return keys;
  }, [groupedRows, normalizedQuery, searching]);

  const activityRows = useMemo(
    () =>
      matchingActivityKeys
        ? groupedRows.filter((row) =>
            matchingActivityKeys.has(activityRowKey(row)),
          )
        : groupedRows,
    [groupedRows, matchingActivityKeys],
  );

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
      (row) => getActivityRowStatus(row) === "running",
    );
    const { ordered, state } = orderByFirstSeen(
      running,
      activityRowKey,
      runningOrderRef.current,
      true,
    );
    // Safe to mutate the ref inside useMemo: orderByFirstSeen is idempotent
    // for unchanged input, so a repeat run (e.g. StrictMode) yields the same
    // frozen indices.
    runningOrderRef.current = state;
    const visible = matchingActivityKeys
      ? ordered.filter((row) => matchingActivityKeys.has(activityRowKey(row)))
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
  }, [groupedRows, matchingActivityKeys]);

  const doneRows = useMemo(
    () =>
      [...activityRows]
        .filter((row) => getActivityRowStatus(row) !== "running")
        .sort(
          (a, b) =>
            getActivityRowCompletedAtMs(b) - getActivityRowCompletedAtMs(a) ||
            activityRowKey(a).localeCompare(activityRowKey(b)),
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

  // The standalone Files section was intentionally removed from the default
  // sidebar when files moved under each agent, but it is still essential as
  // a global search result. Derive once per file-feed update; query changes
  // only scan the cheap normalized path index.
  const searchableFiles = useMemo(
    () =>
      deriveConversationFiles(filesFeed.files).map((entry) => ({
        entry,
        searchText: entry.path.toLowerCase(),
      })),
    [filesFeed.files],
  );
  const filteredFiles = useMemo(() => {
    if (!searching) return EMPTY_FILES;
    return searchableFiles
      .filter(({ searchText }) => searchText.includes(normalizedQuery))
      .map(({ entry }) => entry);
  }, [normalizedQuery, searchableFiles, searching]);

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
  const visibleActivityRows = useMemo(
    () => [...runningRows, ...visibleDoneRows],
    [runningRows, visibleDoneRows],
  );
  const visibleFiles = useMemo(
    () => filteredFiles.slice(0, caps.files),
    [caps.files, filteredFiles],
  );
  const upNext = useMemo(
    () => filteredSchedules.slice(0, caps.schedule),
    [filteredSchedules, caps.schedule],
  );
  const storePreview = storeItems.slice(0, caps.store);

  const hasActivity = visibleActivityRows.length > 0;
  const hasFiles = searching && visibleFiles.length > 0;
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

  // Exact thread identity is the durable viewer key. Opening Activity chat
  // never mutates composer context and never navigates the root transcript.
  const handleSelectTask = useCallback(
    (task: TaskItem) => {
      if (!conversationId) return;
      openAgentThreadTab({
        threadId: task.id,
        conversationId,
        agentType: task.agentType,
        title: task.description.trim() || task.agentType || "Agent thread",
      });
      onNavigate?.();
    },
    [conversationId, onNavigate],
  );

  if (!hasActivity && !hasFiles && !hasSchedule && !hasStore) {
    return renderEmpty ? <>{renderEmpty()}</> : null;
  }

  return (
    <>
      <div className="chat-workspace-strip__panel">
        {hasActivity && (
          <WorkspaceSection title="Activity" sectionId="activity">
            <TasksList
              rows={visibleActivityRows}
              isTaskExpanded={isTaskExpanded}
              isCompactTaskExpanded={isCompactTaskExpanded}
              onToggleTask={toggleTask}
              onSelectTask={handleSelectTask}
              isGroupExpanded={isGroupExpanded}
              onToggleGroup={toggleGroup}
              agentFiles={agentFiles}
              onOpenFile={handleOpenFile}
            />
          </WorkspaceSection>
        )}

        {hasFiles && (
          <WorkspaceSection title="Files" sectionId="files">
            <ul className="chat-workspace-strip__list">
              {visibleFiles.map((file) => (
                <li
                  key={file.path}
                  className="chat-workspace-strip__row"
                  title={file.path}
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => handleOpenFile(file)}
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
            </ul>
          </WorkspaceSection>
        )}

        {hasSchedule && (
          <WorkspaceSection title="Schedule" sectionId="schedule">
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
          <WorkspaceSection title="Store" sectionId="store">
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
    </>
  );
});
