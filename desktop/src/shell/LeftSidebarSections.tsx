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
import { History, CheckCircle2, Circle, AlertCircle } from "@/ui/icons";
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

const activityRowText = (row: ActivityRow): string =>
  row.kind === "task"
    ? getTaskDisplayText(row.task) || row.task.description
    : row.group.label;

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
    // Running rows carry no status glyph — the label's text shimmer is the
    // single working affordance (matching the inline agent cards), so the
    // former loader spinner would be a redundant second indicator. The icon
    // slot stays reserved (see `.chat-workspace-strip__task-icon-wrap`) so
    // the label still lines up with the settled rows below it.
    case "running":
      return null;
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
}: {
  task: TaskItem;
  expanded: boolean;
  onToggle: (taskId: string, nextExpanded: boolean) => void;
  files: ReadonlyArray<ConversationFileEntry>;
  onOpenFile: (entry: ConversationFileEntry) => void;
}) {
  const label = (getTaskDisplayText(task) || task.description).trim();
  const summaries = useAgentProgressSummaries(task.id);
  const hasSummaries = summaries.length > 0;
  const hasFiles = files.length > 0;
  const hasDetail = hasSummaries || hasFiles;
  return (
    <li
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
      {expanded && hasDetail ? (
        <div className="chat-workspace-strip__task-detail">
          {hasSummaries ? (
            <AgentProgressSummaries agentId={task.id} max={AGENT_SUMMARY_CAP} />
          ) : null}
          {hasFiles ? (
            <ul className="chat-workspace-strip__list chat-workspace-strip__task-files">
              {files.map((file) => (
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
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
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
}: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: (groupKey: string) => void;
  isTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
}) {
  const label = group.label.trim();
  const statusText = getTaskGroupStatusText(group);
  return (
    <li
      className="chat-workspace-strip__task-row chat-workspace-strip__group-row"
      data-status={group.status}
      title={`${label} — ${statusText}`}
    >
      <button
        type="button"
        className="chat-workspace-strip__task-button"
        onClick={() => onToggle(group.groupKey)}
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
      {expanded ? (
        <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks chat-workspace-strip__group-members">
          {group.members.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={isTaskExpanded(task)}
              onToggle={onToggleTask}
              files={agentFiles.get(task.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
});

const TasksList = memo(function TasksList({
  rows,
  isTaskExpanded,
  onToggleTask,
  expandedGroupKeys,
  onToggleGroup,
  agentFiles,
  onOpenFile,
}: {
  rows: ReadonlyArray<ActivityRow>;
  isTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  expandedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (groupKey: string) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
}) {
  return (
    <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks">
      {rows.map((row) =>
        row.kind === "task" ? (
          <TaskRow
            key={row.task.id}
            task={row.task}
            expanded={isTaskExpanded(row.task)}
            onToggle={onToggleTask}
            files={agentFiles.get(row.task.id) ?? EMPTY_FILES}
            onOpenFile={onOpenFile}
          />
        ) : (
          <GroupRow
            key={`group:${row.group.groupKey}`}
            group={row.group}
            expanded={expandedGroupKeys.has(row.group.groupKey)}
            onToggle={onToggleGroup}
            isTaskExpanded={isTaskExpanded}
            onToggleTask={onToggleTask}
            agentFiles={agentFiles}
            onOpenFile={onOpenFile}
          />
        ),
      )}
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

export function LeftSidebarSections({
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
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);
  // Per-agent expand/collapse: an expanded activity row reveals that
  // agent's recent reasoning summaries and the files it produced.
  //
  // Default state is derived from the agent's status — a running agent comes
  // up expanded, a finished one collapsed — so a freshly-started agent auto-
  // expands. `expandOverrides` records rows the user has explicitly toggled;
  // those win over the status default and are never stomped by it.
  const [expandOverrides, setExpandOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isTaskExpanded = useCallback(
    (task: TaskItem): boolean => {
      const override = expandOverrides.get(task.id);
      return override ?? task.status === "running";
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

  const groupedRows = useMemo(() => groupActivityTasks(allTasks), [allTasks]);

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
    return visible.slice(0, caps.activity);
  }, [groupedRows, query, caps.activity]);

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
  // `activity.activities` gets a fresh array identity on every streamed delta
  // (the activity window is refetched per `localChat:updated`), so a plain
  // `useMemo([activity.activities])` re-ran the heavy per-agent file
  // derivation on every token — the 44ms sidebar offender in the trace. Gate
  // the recompute on a cheap content signature of the file-contributing
  // events so it only re-runs when an agent's files actually change; the
  // returned Map keeps a stable reference across deltas otherwise (so the
  // memoized task rows that take it as a prop also stop re-reconciling).
  const agentFilesCacheRef = useRef<{
    signature: string;
    result: Map<string, ConversationFileEntry[]>;
  } | null>(null);
  const agentFiles = useMemo(() => {
    const signature = agentFilesSignature(activity.activities);
    const cached = agentFilesCacheRef.current;
    if (cached && cached.signature === signature) return cached.result;
    const result = deriveAgentFilesMap(activity.activities);
    agentFilesCacheRef.current = { signature, result };
    return result;
  }, [activity.activities]);

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
              expandedGroupKeys={expandedGroupKeys}
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
}
