/**
 * Right-aligned workspace strip rendered next to the active chat
 * conversation surface (NOT on the home content). When the display
 * sidebar opens, this stays mounted as a clipped zero-width slot so
 * the chat column can resize smoothly.
 *
 * Everything lives inside a single outlined panel (rounded corners,
 * 1px subtle border, no painted fill); sections inside are separated
 * by thin horizontal dividers. Empty sections are omitted entirely.
 *
 * Shares its data sources with the display sidebar's Chat tab
 * (`ChatHomeOverview`) — same `useChatRuntime` + `useConversationSchedules`
 * plumbing — so both surfaces stay in sync without one re-deriving
 * against the other.
 */
import {
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  History,
  CheckCircle2,
  Circle,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import {
  useConversationSchedules,
  type ScheduleEntry,
} from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import {
  extractTasksFromActivities,
  getTaskDisplayText,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/shell/display/derive-conversation-files";
import { basenameOf } from "@/shell/display/path-to-viewer";
import { displayTabs, useDisplayPanelOpen } from "@/shell/display/tab-store";
import { DisplayTabIcon } from "@/shell/display/icons";
import {
  ActivityHistoryDialog,
  type ActivityHistorySection,
} from "@/shell/display/ActivityHistoryDialog";
import {
  displayTabKindForPayload,
  payloadToTabSpec,
} from "@/shell/display/payload-to-tab-spec";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "../../../../runtime/kernel/shared/scheduling";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useChatWorkspaceStripStore } from "./chat-workspace-strip-store";
import { TextShimmer } from "./TextShimmer";
import { WorkspaceActionsList } from "./WorkspaceActionsList";
import "./chat-workspace-strip.css";

const NOW_VISIBLE = 4;
const DONE_VISIBLE = 4;
const FILES_VISIBLE = 5;
const UPNEXT_VISIBLE = 4;
const EMPTY_TASKS: TaskItem[] = [];

function WorkspaceSection({
  title,
  children,
  onOpenHistory,
  historyLabel,
}: {
  title: string;
  children?: ReactNode;
  onOpenHistory?: () => void;
  historyLabel?: string;
}) {
  return (
    <section className="chat-workspace-strip__section">
      <header className="chat-workspace-strip__section-header">
        <span className="chat-workspace-strip__section-title">{title}</span>
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
      <div className="chat-workspace-strip__section-body">{children}</div>
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

function TasksList({ tasks }: { tasks: ReadonlyArray<TaskItem> }) {
  return (
    <ul className="chat-workspace-strip__list chat-workspace-strip__list--tasks">
      {tasks.map((task) => {
        const label = (getTaskDisplayText(task) || task.description).trim();
        return (
          <li
            key={task.id}
            className="chat-workspace-strip__task-row"
            data-status={task.status}
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
          </li>
        );
      })}
    </ul>
  );
}

type ChatWorkspaceStripProps = {
  forceHidden?: boolean;
  /** Rendered beside expanded display-panel chat; not clipped by panelOpen. */
  embeddedInDisplayPanel?: boolean;
  onNewChat?: () => void | Promise<void>;
  onSelectArea?: () => void;
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

export function ChatWorkspaceStrip({
  forceHidden = false,
  embeddedInDisplayPanel = false,
  onNewChat,
  onSelectArea,
}: ChatWorkspaceStripProps) {
  const panelOpen = useDisplayPanelOpen();
  const { stripVisible } = useChatWorkspaceStripStore();
  const chat = useChatRuntime();
  const { state } = useUiState();

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;
  const filesFeed = chat.conversation.files;
  const schedules = useConversationSchedules(conversationId);
  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);
  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);

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

  const runningTasks = useMemo(
    () =>
      [...allTasks]
        .filter((task) => task.status === "running")
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .slice(0, NOW_VISIBLE),
    [allTasks],
  );

  const doneTasks = useMemo(
    () =>
      [...allTasks]
        .filter((task) => task.status !== "running")
        .sort((a, b) => {
          const aTime = a.completedAtMs ?? a.lastUpdatedAtMs ?? a.startedAtMs;
          const bTime = b.completedAtMs ?? b.lastUpdatedAtMs ?? b.startedAtMs;
          return bTime - aTime;
        }),
    [allTasks],
  );
  const allFiles = useMemo(
    () => deriveConversationFiles(filesFeed.files),
    [filesFeed.files],
  );

  const nowMs = Date.now();

  const visibleDoneTasks = doneTasks.slice(0, DONE_VISIBLE);
  const hiddenDoneCount = doneTasks.length - visibleDoneTasks.length;
  const visibleActivityTasks = useMemo(
    () => [...runningTasks, ...visibleDoneTasks],
    [runningTasks, visibleDoneTasks],
  );
  const visibleFiles = allFiles.slice(0, FILES_VISIBLE);
  const hiddenFilesCount = allFiles.length - visibleFiles.length;
  const upNext = useMemo(
    () => schedules.slice(0, UPNEXT_VISIBLE),
    [schedules],
  );
  const hiddenScheduleCount = schedules.length - upNext.length;

  const hasActivity = visibleActivityTasks.length > 0;
  const hasFiles = allFiles.length > 0;
  const hasSchedule = upNext.length > 0;
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, conversationId)];
  }, [conversationId, openScheduleEntry]);
  const handleOpenFile = (entry: ConversationFileEntry) => {
    displayTabs.openTab(payloadToTabSpec(entry.payload));
  };
  const hidden =
    forceHidden || !stripVisible || (panelOpen && !embeddedInDisplayPanel);

  return (
    <aside
      className={`chat-workspace-strip${
        hidden ? " chat-workspace-strip--hidden" : ""
      }${embeddedInDisplayPanel ? " chat-workspace-strip--display-panel" : ""}`}
      aria-label="Workspace"
      aria-hidden={hidden}
    >
      <div className="chat-workspace-strip__inner">
        <div className="chat-workspace-strip__panel-frame">
          <div className="chat-workspace-strip__panel">
            <WorkspaceSection title="Actions">
              <div className="chat-workspace-strip__actions-body">
                <WorkspaceActionsList
                  onNewChat={onNewChat}
                  onSelectArea={onSelectArea}
                />
              </div>
            </WorkspaceSection>

            {hasActivity && (
              <>
                <div
                  className="chat-workspace-strip__divider"
                  aria-hidden="true"
                />
                <WorkspaceSection
                  title="Activity"
                  onOpenHistory={
                    hiddenDoneCount > 0
                      ? () => setHistorySection("done")
                      : undefined
                  }
                  historyLabel={`View all activity (${doneTasks.length})`}
                >
                  <TasksList tasks={visibleActivityTasks} />
                </WorkspaceSection>
              </>
            )}

            {hasFiles && (
              <>
                <div
                  className="chat-workspace-strip__divider"
                  aria-hidden="true"
                />
                <WorkspaceSection
                  title="Files"
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
              </>
            )}

            {hasSchedule && (
              <>
                <div
                  className="chat-workspace-strip__divider"
                  aria-hidden="true"
                />
                <WorkspaceSection
                  title="Schedule"
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
              </>
            )}
          </div>
        </div>
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
        }}
        onOpenFile={(entry) => {
          handleOpenFile(entry);
          setHistorySection(null);
        }}
      />
    </aside>
  );
}
