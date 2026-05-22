/**
 * Right-aligned workspace strip rendered next to the active chat
 * conversation surface (NOT on the home content). When the display
 * sidebar opens, this stays mounted as a clipped zero-width slot so
 * the chat column can resize smoothly.
 *
 * Each section is its own outlined card (rounded corners, 1px subtle
 * border, no painted fill) with a header row that carries the title +
 * a chevron collapse affordance. Cards stack vertically; empty cards
 * are omitted entirely.
 *
 * Shares its data sources with the display sidebar's Chat tab
 * (`ChatHomeOverview`) — same `useChatRuntime` + `useConversationSchedules`
 * plumbing — so both surfaces stay in sync without one re-deriving
 * against the other.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import {
  ChevronDown,
  History,
  Activity as ActivityIcon,
  FolderClosed,
  CalendarClock,
  LayoutPanelTop,
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
import { displayTabs, useDisplayPanelLayout } from "@/shell/display/tab-store";
import {
  CANVAS_DISPLAY_TAB_ID,
  MEDIA_DISPLAY_TAB_ID,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
  openCanvasDisplayTab,
  openMediaDisplayTab,
  openStoreDisplayTab,
  openTrashDisplayTab,
} from "@/shell/display/default-tabs";
import type { DisplayTabKind } from "@/shell/display/types";
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
import {
  chatWorkspaceStripStore,
  useChatWorkspaceStripStore,
  type WorkspaceStripSection,
  type WorkspaceStripSections,
} from "./chat-workspace-strip-store";
import { TextShimmer } from "./TextShimmer";
import {
  WORKSPACE_STRIP_MOCK_ENABLED,
  mockWorkspaceStripDoneTasks,
  mockWorkspaceStripFiles,
  mockWorkspaceStripRunningTasks,
  mockWorkspaceStripSchedules,
} from "./chat-workspace-strip-mock";
import "./chat-workspace-strip.css";

const NOW_VISIBLE = 4;
const DONE_VISIBLE = 4;
const FILES_VISIBLE = 5;
const UPNEXT_VISIBLE = 5;
const EMPTY_TASKS: TaskItem[] = [];

type TabOpenOption = {
  id: string;
  label: string;
  kind: DisplayTabKind;
  open: () => void;
};

const SECTION_TOGGLES: ReadonlyArray<{
  id: WorkspaceStripSection;
  label: string;
  icon: ReactNode;
}> = [
  {
    id: "activity",
    label: "Activity",
    icon: <ActivityIcon size={14} strokeWidth={2.25} />,
  },
  {
    id: "files",
    label: "Files",
    icon: <FolderClosed size={14} strokeWidth={2.25} />,
  },
  {
    id: "schedule",
    label: "Schedule",
    icon: <CalendarClock size={14} strokeWidth={2.25} />,
  },
];

const TAB_OPTIONS: ReadonlyArray<TabOpenOption> = [
  {
    id: CANVAS_DISPLAY_TAB_ID,
    label: "Canvas",
    kind: "canvas",
    open: openCanvasDisplayTab,
  },
  {
    id: MEDIA_DISPLAY_TAB_ID,
    label: "Media",
    kind: "media",
    open: openMediaDisplayTab,
  },
  {
    id: STORE_DISPLAY_TAB_ID,
    label: "Store",
    kind: "store",
    open: openStoreDisplayTab,
  },
  {
    id: TRASH_DISPLAY_TAB_ID,
    label: "Trash",
    kind: "trash",
    open: openTrashDisplayTab,
  },
];

function SectionToggles({ sections }: { sections: WorkspaceStripSections }) {
  return (
    <div
      className="chat-workspace-strip__section-toggles"
      role="toolbar"
      aria-label="Show or hide workspace sections"
    >
      {SECTION_TOGGLES.map((toggle) => (
        <button
          key={toggle.id}
          type="button"
          className="chat-workspace-strip__section-toggle"
          aria-label={`${sections[toggle.id] ? "Hide" : "Show"} ${toggle.label}`}
          aria-pressed={sections[toggle.id]}
          title={`${sections[toggle.id] ? "Hide" : "Show"} ${toggle.label}`}
          onClick={() => chatWorkspaceStripStore.toggleSection(toggle.id)}
        >
          {toggle.icon}
        </button>
      ))}
    </div>
  );
}

function WorkspaceCard({
  title,
  icon,
  children,
  defaultOpen = true,
  headerTrailing,
  onOpenHistory,
  historyLabel,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  headerTrailing?: ReactNode;
  onOpenHistory?: () => void;
  historyLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggleOpen = () => setOpen((v) => !v);
  return (
    <div className="chat-workspace-strip__card-frame">
      <section
        className={`chat-workspace-strip__card${open ? "" : " chat-workspace-strip__card--collapsed"}`}
      >
      <div className="chat-workspace-strip__card-header">
        <button
          type="button"
          className="chat-workspace-strip__card-header-main"
          onClick={toggleOpen}
          aria-expanded={open}
        >
          <span className="chat-workspace-strip__card-title">
            <span
              className="chat-workspace-strip__card-title-icon"
              aria-hidden="true"
            >
              {icon}
            </span>
            {title}
          </span>
        </button>
        {headerTrailing}
        {onOpenHistory ? (
          <button
            type="button"
            className="chat-workspace-strip__card-header-history"
            onClick={onOpenHistory}
            aria-label={historyLabel ?? `View ${title} history`}
            title={historyLabel ?? `View ${title} history`}
          >
            <History size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="chat-workspace-strip__card-header-chevron"
          onClick={toggleOpen}
          tabIndex={-1}
          aria-hidden="true"
        >
          <ChevronDown
            className="chat-workspace-strip__card-chevron"
            size={14}
            strokeWidth={2}
          />
        </button>
      </div>
      <div
        className="chat-workspace-strip__card-body-grow"
        data-expanded={open || undefined}
        aria-hidden={!open}
      >
        <div className="chat-workspace-strip__card-body-inner">
          <div className="chat-workspace-strip__card-body">{children}</div>
        </div>
      </div>
      </section>
    </div>
  );
}

function TasksList({ tasks }: { tasks: ReadonlyArray<TaskItem> }) {
  return (
    <ul className="chat-workspace-strip__list">
      {tasks.map((task) => {
        const label = (getTaskDisplayText(task) || task.description).trim();
        return (
          <li
            key={task.id}
            className="chat-workspace-strip__row"
            data-status={task.status === "running" ? "now" : "done"}
          >
            <span className="chat-workspace-strip__row-label">
              {task.status === "running" ? (
                <TextShimmer
                  text={label}
                  durationMs={2000}
                  className="chat-workspace-strip__row-label-shimmer"
                />
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
}: ChatWorkspaceStripProps) {
  const { panelOpen } = useDisplayPanelLayout();
  const { stripVisible, sections } = useChatWorkspaceStripStore();
  const chat = useChatRuntime();
  const { state } = useUiState();

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;
  const filesFeed = chat.conversation.files;
  const schedules = useConversationSchedules(conversationId);
  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);
  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);
  const scrollRef = useEdgeFadeRef<HTMLDivElement>({ axis: "vertical" });

  const allTasks = useMemo(() => {
    const persisted = extractTasksFromActivities(activity.activities, {
      latestMessageTimestampMs: activity.latestMessageTimestampMs,
    });
    return mergeFooterTasks(persisted, liveTasks);
  }, [activity.activities, activity.latestMessageTimestampMs, liveTasks]);

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

  const useMockContent = WORKSPACE_STRIP_MOCK_ENABLED;
  const displayRunningTasks =
    useMockContent && runningTasks.length === 0
      ? mockWorkspaceStripRunningTasks
      : runningTasks;
  const displayDoneTasks =
    useMockContent && doneTasks.length === 0
      ? mockWorkspaceStripDoneTasks
      : doneTasks;
  const displayVisibleDoneTasks = displayDoneTasks.slice(0, DONE_VISIBLE);
  const displayHiddenDoneCount =
    displayDoneTasks.length - displayVisibleDoneTasks.length;
  const displayAllFiles =
    useMockContent && allFiles.length === 0
      ? mockWorkspaceStripFiles
      : allFiles;
  const displayVisibleFiles = displayAllFiles.slice(0, FILES_VISIBLE);
  const displayHiddenFilesCount =
    displayAllFiles.length - displayVisibleFiles.length;
  const displaySchedules =
    useMockContent && schedules.length === 0
      ? mockWorkspaceStripSchedules(nowMs)
      : schedules;
  const upNext = useMemo(
    () => displaySchedules.slice(0, UPNEXT_VISIBLE),
    [displaySchedules],
  );
  const hiddenScheduleCount = displaySchedules.length - upNext.length;

  const hasActivity =
    displayRunningTasks.length > 0 || displayVisibleDoneTasks.length > 0;
  const hasFiles = displayAllFiles.length > 0;
  const hasSchedule = upNext.length > 0;
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, conversationId)];
  }, [conversationId, openScheduleEntry]);
  const handleOpenFile = (entry: ConversationFileEntry) => {
    displayTabs.openTab(payloadToTabSpec(entry.payload));
  };
  const hidden =
    forceHidden ||
    !stripVisible ||
    (panelOpen && !embeddedInDisplayPanel);
  const showActivity = sections.activity && hasActivity;
  const showFiles = sections.files && hasFiles;
  const showSchedule = sections.schedule && hasSchedule;

  const renderReveal = (visible: boolean, content: ReactNode) => (
    <div
      className="chat-workspace-strip__section-reveal"
      data-visible={visible || undefined}
      aria-hidden={!visible}
    >
      <div className="chat-workspace-strip__section-reveal-inner">{content}</div>
    </div>
  );

  return (
    <aside
      className={`chat-workspace-strip${
        hidden ? " chat-workspace-strip--hidden" : ""
      }${embeddedInDisplayPanel ? " chat-workspace-strip--display-panel" : ""}`}
      aria-label="Workspace"
      aria-hidden={hidden}
    >
      <div className="chat-workspace-strip__inner">
        <div
          className="chat-workspace-strip__scroll"
          ref={scrollRef}
          data-at-start="true"
          data-at-end="true"
        >
          <WorkspaceCard
            title="Open"
            icon={<LayoutPanelTop size={12} strokeWidth={2.25} />}
            headerTrailing={<SectionToggles sections={sections} />}
          >
            <ul className="chat-workspace-strip__tab-list">
              {TAB_OPTIONS.map((opt) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    className="chat-workspace-strip__tab-button"
                    onClick={() => {
                      if (
                        displayTabs
                          .getTabListSnapshot()
                          .tabs.some((t) => t.id === opt.id)
                      ) {
                        displayTabs.activateTab(opt.id);
                      } else {
                        opt.open();
                      }
                    }}
                  >
                    <DisplayTabIcon kind={opt.kind} size={16} />
                    <span>{opt.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceCard>

          {hasActivity &&
            renderReveal(
              showActivity,
              <WorkspaceCard
              title="Activity"
              icon={<ActivityIcon size={12} strokeWidth={2.25} />}
              onOpenHistory={
                displayHiddenDoneCount > 0
                  ? () => setHistorySection("done")
                  : undefined
              }
              historyLabel={`View all activity (${displayDoneTasks.length})`}
            >
              {displayRunningTasks.length > 0 && (
                <>
                  <div className="chat-workspace-strip__subhead">Now</div>
                  <TasksList tasks={displayRunningTasks} />
                </>
              )}
              {displayVisibleDoneTasks.length > 0 && (
                <>
                  <div className="chat-workspace-strip__subhead">Done</div>
                  <TasksList tasks={displayVisibleDoneTasks} />
                </>
              )}
            </WorkspaceCard>,
            )}

          {hasFiles &&
            renderReveal(
              showFiles,
              <WorkspaceCard
              title="Files"
              icon={<FolderClosed size={12} strokeWidth={2.25} />}
              onOpenHistory={
                displayHiddenFilesCount > 0
                  ? () => setHistorySection("files")
                  : undefined
              }
              historyLabel={`View all files (${displayAllFiles.length})`}
            >
              <ul className="chat-workspace-strip__list">
                {displayVisibleFiles.map((file) => (
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
            </WorkspaceCard>,
            )}

          {hasSchedule &&
            renderReveal(
              showSchedule,
              <WorkspaceCard
              title="Schedule"
              icon={<CalendarClock size={12} strokeWidth={2.25} />}
              onOpenHistory={
                hiddenScheduleCount > 0
                  ? () => setHistorySection("upNext")
                  : undefined
              }
              historyLabel={`View all schedules (${displaySchedules.length})`}
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
            </WorkspaceCard>,
            )}
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
