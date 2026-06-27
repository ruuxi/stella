/**
 * Activity / Files / Schedule / Store sections rendered inside the left
 * sidebar. With `query` supplied they act as the searchable group overview;
 * section rows open the right sidebar viewer (master-detail).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  History,
  CheckCircle2,
  ChevronRight,
  Circle,
  LoaderCircle,
  AlertCircle,
} from "@/ui/icons";
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
  extractTasksFromActivities,
  getTaskDisplayText,
  getTaskGroupStatusText,
  groupActivityTasks,
  mergeFooterTasks,
  type ActivityRow,
  type TaskGroup,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";
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
import type { ChatContext } from "@/shared/types/electron";
import { TextShimmer } from "@/app/chat/TextShimmer";
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
    case "running":
      return (
        <LoaderCircle
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

const taskToActivityContext = (
  task: TaskItem,
): NonNullable<ChatContext["activity"]> => ({
  id: task.id,
  label: (getTaskDisplayText(task) || task.description || "Activity").trim(),
  agentType: task.agentType,
  status: task.status,
  ...(task.runId ? { runId: task.runId } : {}),
  ...(task.anchorTurnId ? { anchorTurnId: task.anchorTurnId } : {}),
  startedAtMs: task.startedAtMs,
  ...(typeof task.completedAtMs === "number"
    ? { completedAtMs: task.completedAtMs }
    : {}),
  lastUpdatedAtMs: task.lastUpdatedAtMs,
});

function TaskRow({
  task,
  selectedActivityId,
  onSelectTask,
}: {
  task: TaskItem;
  selectedActivityId?: string | null;
  onSelectTask: (task: TaskItem) => void;
}) {
  const label = (getTaskDisplayText(task) || task.description).trim();
  return (
    <li
      className="chat-workspace-strip__task-row"
      data-status={task.status}
      data-selected={selectedActivityId === task.id ? "true" : undefined}
      title={label}
    >
      <button
        type="button"
        className="chat-workspace-strip__task-button"
        onClick={() => onSelectTask(task)}
        aria-label={`Use ${label || "activity"} as context`}
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
    </li>
  );
}

function GroupRow({
  group,
  expanded,
  onToggle,
  selectedActivityId,
  onSelectTask,
}: {
  group: TaskGroup;
  expanded: boolean;
  onToggle: (groupKey: string) => void;
  selectedActivityId?: string | null;
  onSelectTask: (task: TaskItem) => void;
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
        <ChevronRight
          className="chat-workspace-strip__group-chevron"
          data-expanded={expanded ? "true" : undefined}
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks chat-workspace-strip__group-members">
          {group.members.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selectedActivityId={selectedActivityId}
              onSelectTask={onSelectTask}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TasksList({
  rows,
  selectedActivityId,
  onSelectTask,
  expandedGroupKeys,
  onToggleGroup,
}: {
  rows: ReadonlyArray<ActivityRow>;
  selectedActivityId?: string | null;
  onSelectTask: (task: TaskItem) => void;
  expandedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (groupKey: string) => void;
}) {
  return (
    <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks">
      {rows.map((row) =>
        row.kind === "task" ? (
          <TaskRow
            key={row.task.id}
            task={row.task}
            selectedActivityId={selectedActivityId}
            onSelectTask={onSelectTask}
          />
        ) : (
          <GroupRow
            key={`group:${row.group.groupKey}`}
            group={row.group}
            expanded={expandedGroupKeys.has(row.group.groupKey)}
            onToggle={onToggleGroup}
            selectedActivityId={selectedActivityId}
            onSelectTask={onSelectTask}
          />
        ),
      )}
    </ul>
  );
}

const activityRowStatus = (row: ActivityRow): TaskItem["status"] =>
  row.kind === "task" ? row.task.status : row.group.status;

const activityRowId = (row: ActivityRow): string =>
  row.kind === "task" ? row.task.id : row.group.groupKey;

const activityRowStartedAtMs = (row: ActivityRow): number =>
  row.kind === "task" ? row.task.startedAtMs : row.group.startedAtMs;

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
  showRunning = true,
}: {
  /** When set, live-filters every section by this query (group overview). */
  query?: string;
  /** Default cap set: compact strip vs. roomier group overview. */
  variant?: "strip" | "overview";
  /** Rendered when nothing matches; strip mode omits it and renders null. */
  renderEmpty?: () => ReactNode;
  /** Fired after a section item is opened/selected — lets a host surface
   *  (e.g. the composer activity tray) dismiss itself. */
  onNavigate?: () => void;
  /** Include in-progress (running) activity rows. The left sidebar opts
   *  out — running work lives in the composer activity pill now — while the
   *  tray / strip keep the full list. */
  showRunning?: boolean;
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
  const toggleGroup = (groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

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

  const activityRows = useMemo(() => {
    const grouped = groupActivityTasks(allTasks);
    if (!query) return grouped;
    return grouped.filter((row) => matchesQuery(activityRowText(row), query));
  }, [allTasks, query]);

  const runningRows = useMemo(
    () =>
      showRunning
        ? [...activityRows]
            .filter((row) => activityRowStatus(row) === "running")
            .sort(
              (a, b) =>
                activityRowStartedAtMs(b) - activityRowStartedAtMs(a) ||
                activityRowId(a).localeCompare(activityRowId(b)),
            )
            .slice(0, caps.activity)
        : [],
    [activityRows, caps.activity, showRunning],
  );

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
  const allFiles = useMemo(() => {
    const derived = deriveConversationFiles(filesFeed.files);
    if (!query) return derived;
    return derived.filter((file) => matchesQuery(basenameOf(file.path), query));
  }, [filesFeed.files, query]);

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

  const visibleDoneRows = doneRows.slice(
    0,
    Math.max(0, caps.activity - runningRows.length),
  );
  const hiddenDoneCount = doneRows.length - visibleDoneRows.length;
  const visibleActivityRows = useMemo(
    () => [...runningRows, ...visibleDoneRows],
    [runningRows, visibleDoneRows],
  );
  const visibleFiles = allFiles.slice(0, caps.files);
  const hiddenFilesCount = allFiles.length - visibleFiles.length;
  const upNext = useMemo(
    () => filteredSchedules.slice(0, caps.schedule),
    [filteredSchedules, caps.schedule],
  );
  const hiddenScheduleCount = filteredSchedules.length - upNext.length;
  const storePreview = storeItems.slice(0, caps.store);
  const hiddenStoreCount = storeItems.length - storePreview.length;

  const hasActivity = visibleActivityRows.length > 0;
  const hasFiles = allFiles.length > 0;
  const hasSchedule = upNext.length > 0;
  // Store is no longer listed by default — it only surfaces while searching.
  const hasStore = searching && storePreview.length > 0;
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, conversationId)];
  }, [conversationId, openScheduleEntry]);

  const handleOpenFile = (entry: ConversationFileEntry) => {
    openDisplayPayloadTab(entry.payload);
    onNavigate?.();
  };
  const handleSelectTask = (task: TaskItem) => {
    const activityContext = taskToActivityContext(task);
    chat.composer.setChatContext((prev) => ({
      ...(prev ?? {
        window: null,
        browserUrl: null,
        selectedText: null,
        regionScreenshots: [],
      }),
      activity: activityContext,
    }));
    chat.composer.requestFocus?.();
    onNavigate?.();
  };

  if (!hasActivity && !hasFiles && !hasSchedule && !hasStore) {
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
              selectedActivityId={chat.composer.chatContext?.activity?.id}
              onSelectTask={handleSelectTask}
              expandedGroupKeys={expandedGroupKeys}
              onToggleGroup={toggleGroup}
            />
          </WorkspaceSection>
        )}

        {hasFiles && (
          <WorkspaceSection
            title="Files"
            sectionId="files"
            onOpenHistory={
              hiddenFilesCount > 0
                ? () => setHistorySection("files")
                : undefined
            }
            historyLabel={`View all files (${allFiles.length})`}
          >
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
                  <span className="chat-workspace-strip__row-label">
                    {entry.name.trim()}
                  </span>
                  <span className="chat-workspace-strip__row-meta">
                    {formatNextRun(entry.nextRunAtMs, nowMs)}
                  </span>
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
        onSelectTask={(task) => {
          handleSelectTask(task);
          setHistorySection(null);
        }}
        onOpenSchedule={(entry) => {
          setOpenScheduleEntry(entry);
        }}
        onOpenFile={(entry) => {
          handleOpenFile(entry);
          setHistorySection(null);
        }}
      />
    </>
  );
}
