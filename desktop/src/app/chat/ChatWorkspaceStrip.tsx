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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  History,
  Activity as ActivityIcon,
  Check,
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
import {
  areWorkspaceStripOpenPanelsEqual,
  DEFAULT_WORKSPACE_STRIP_OPEN_PANELS,
  resolveWorkspaceStripOpenPanels,
  type WorkspaceStripOpenPanels,
  type WorkspaceStripPanelId,
  type WorkspaceStripPanelMeasurements,
} from "./chat-workspace-strip-layout";
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
const UPNEXT_VISIBLE = 4;
const EMPTY_TASKS: TaskItem[] = [];

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

function SectionToggles({
  sections,
  onToggleSection,
}: {
  sections: WorkspaceStripSections;
  onToggleSection: (section: WorkspaceStripSection) => void;
}) {
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
          onClick={() => onToggleSection(toggle.id)}
        >
          {toggle.icon}
        </button>
      ))}
    </div>
  );
}

function WorkspaceCard({
  id,
  title,
  icon,
  children,
  open,
  onToggle,
  measureRef,
  headerTrailing,
  onOpenHistory,
  historyLabel,
  headerOnly = false,
}: {
  id: WorkspaceStripPanelId;
  title: string;
  icon: ReactNode;
  children?: ReactNode;
  open: boolean;
  onToggle: (panelId: WorkspaceStripPanelId) => void;
  measureRef: (node: HTMLDivElement | null) => void;
  headerTrailing?: ReactNode;
  onOpenHistory?: () => void;
  historyLabel?: string;
  headerOnly?: boolean;
}) {
  const toggleOpen = () => onToggle(id);
  const titleContent = (
    <span className="chat-workspace-strip__card-title">
      <span
        className="chat-workspace-strip__card-title-icon"
        aria-hidden="true"
      >
        {icon}
      </span>
      {title}
    </span>
  );
  return (
    <div className="chat-workspace-strip__card-frame" ref={measureRef}>
      <section
        data-workspace-strip-card
        className={`chat-workspace-strip__card${open && !headerOnly ? "" : " chat-workspace-strip__card--collapsed"}`}
      >
        <div
          className="chat-workspace-strip__card-header"
          data-workspace-strip-card-header
        >
          {headerOnly ? (
            <div className="chat-workspace-strip__card-header-main">
              {titleContent}
            </div>
          ) : (
            <button
              type="button"
              className="chat-workspace-strip__card-header-main"
              onClick={toggleOpen}
              aria-expanded={open}
            >
              {titleContent}
            </button>
          )}
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
          {!headerOnly ? (
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
          ) : null}
        </div>
        {!headerOnly ? (
          <div
            className="chat-workspace-strip__card-body-grow"
            data-expanded={open || undefined}
            aria-hidden={!open}
          >
            <div
              className="chat-workspace-strip__card-body-inner"
              data-workspace-strip-card-body-inner
            >
              <div className="chat-workspace-strip__card-body">{children}</div>
            </div>
          </div>
        ) : null}
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
                  className="text-shimmer--base chat-workspace-strip__row-label-shimmer"
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

const parseCssPx = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function ChatWorkspaceStrip({
  forceHidden = false,
  embeddedInDisplayPanel = false,
}: ChatWorkspaceStripProps) {
  const { panelOpen } = useDisplayPanelLayout();
  const { stripVisible, sections } = useChatWorkspaceStripStore();
  const chat = useChatRuntime();
  const { state } = useUiState();
  const panelFrameRefs = useRef<
    Record<WorkspaceStripPanelId, HTMLDivElement | null>
  >({
    open: null,
    activity: null,
    files: null,
    schedule: null,
  });

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;
  const filesFeed = chat.conversation.files;
  const schedules = useConversationSchedules(conversationId);
  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);
  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);
  const [openPanels, setOpenPanels] = useState<WorkspaceStripOpenPanels>(
    DEFAULT_WORKSPACE_STRIP_OPEN_PANELS,
  );
  const stripStackRef = useRef<HTMLDivElement | null>(null);
  const pendingJustOpenedPanelRef = useRef<WorkspaceStripPanelId | null>(null);

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
    forceHidden || !stripVisible || (panelOpen && !embeddedInDisplayPanel);
  const latestOpenPanelsRef = useRef(openPanels);
  latestOpenPanelsRef.current = openPanels;
  const availablePanelIds = useMemo<WorkspaceStripPanelId[]>(() => {
    const ids: WorkspaceStripPanelId[] = ["open"];
    if (sections.activity && hasActivity) ids.push("activity");
    if (sections.files && hasFiles) ids.push("files");
    if (sections.schedule && hasSchedule) ids.push("schedule");
    return ids;
  }, [
    hasActivity,
    hasFiles,
    hasSchedule,
    sections.activity,
    sections.files,
    sections.schedule,
  ]);

  const setPanelFrameRef = useCallback(
    (panelId: WorkspaceStripPanelId, node: HTMLDivElement | null) => {
      panelFrameRefs.current[panelId] = node;
    },
    [],
  );

  const measurePanelHeights =
    useCallback((): WorkspaceStripPanelMeasurements | null => {
      const measurements: WorkspaceStripPanelMeasurements = {};

      for (const panelId of availablePanelIds) {
        const frame = panelFrameRefs.current[panelId];
        const card = frame?.querySelector<HTMLElement>(
          "[data-workspace-strip-card]",
        );
        const header = frame?.querySelector<HTMLElement>(
          "[data-workspace-strip-card-header]",
        );
        const bodyInner = frame?.querySelector<HTMLElement>(
          "[data-workspace-strip-card-body-inner]",
        );

        if (!card || !header) return null;

        const cardStyle = window.getComputedStyle(card);
        const borderHeight =
          parseCssPx(cardStyle.borderTopWidth) +
          parseCssPx(cardStyle.borderBottomWidth);
        const collapsedHeight = Math.ceil(
          header.getBoundingClientRect().height + borderHeight,
        );

        if (!bodyInner) {
          measurements[panelId] = {
            collapsedHeight,
            expandedHeight: collapsedHeight,
          };
          continue;
        }

        measurements[panelId] = {
          collapsedHeight,
          expandedHeight: Math.ceil(collapsedHeight + bodyInner.scrollHeight),
        };
      }

      return measurements;
    }, [availablePanelIds]);

  const resolvePanelsForAvailableHeight = useCallback(
    (
      requestedOpenPanels: WorkspaceStripOpenPanels,
      justOpened: WorkspaceStripPanelId | null = null,
    ): WorkspaceStripOpenPanels => {
      const stack = stripStackRef.current;
      if (hidden || !stack) return requestedOpenPanels;

      const measurements = measurePanelHeights();
      if (!measurements) return requestedOpenPanels;

      return resolveWorkspaceStripOpenPanels({
        availableHeight: stack.clientHeight,
        availablePanels: availablePanelIds,
        justOpened,
        measurements,
        openPanels: requestedOpenPanels,
      });
    },
    [availablePanelIds, hidden, measurePanelHeights],
  );

  const applyOpenPanels = useCallback((next: WorkspaceStripOpenPanels) => {
    setOpenPanels((current) =>
      areWorkspaceStripOpenPanelsEqual(current, next) ? current : next,
    );
  }, []);

  const fitCurrentPanels = useCallback(
    (justOpened: WorkspaceStripPanelId | null = null) => {
      const currentOpenPanels = latestOpenPanelsRef.current;
      const resolved = resolvePanelsForAvailableHeight(
        currentOpenPanels,
        justOpened,
      );
      if (!areWorkspaceStripOpenPanelsEqual(currentOpenPanels, resolved)) {
        applyOpenPanels(resolved);
      }
    },
    [applyOpenPanels, resolvePanelsForAvailableHeight],
  );

  const handleTogglePanel = useCallback(
    (panelId: WorkspaceStripPanelId) => {
      const requestedOpenPanels = {
        ...latestOpenPanelsRef.current,
        [panelId]: !latestOpenPanelsRef.current[panelId],
      };
      const justOpened = requestedOpenPanels[panelId] ? panelId : null;
      const resolved = resolvePanelsForAvailableHeight(
        requestedOpenPanels,
        justOpened,
      );
      applyOpenPanels(resolved);
    },
    [applyOpenPanels, resolvePanelsForAvailableHeight],
  );

  const handleToggleSection = useCallback((section: WorkspaceStripSection) => {
    const visible = chatWorkspaceStripStore.getSnapshot().sections[section];
    if (visible) {
      chatWorkspaceStripStore.setSectionVisible(section, false);
      return;
    }

    pendingJustOpenedPanelRef.current = section;
    setOpenPanels((current) => ({ ...current, [section]: true }));
    chatWorkspaceStripStore.setSectionVisible(section, true);
  }, []);

  useLayoutEffect(() => {
    const justOpened = pendingJustOpenedPanelRef.current;
    pendingJustOpenedPanelRef.current = null;
    fitCurrentPanels(justOpened);
  });

  useEffect(() => {
    const stack = stripStackRef.current;
    if (!stack || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const scheduleFit = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        fitCurrentPanels();
      });
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(stack);
    for (const panelId of availablePanelIds) {
      const frameNode = panelFrameRefs.current[panelId];
      if (frameNode) observer.observe(frameNode);
    }

    scheduleFit();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [availablePanelIds, fitCurrentPanels]);

  const renderReveal = (visible: boolean, content: ReactNode) => (
    <div
      className="chat-workspace-strip__section-reveal"
      data-visible={visible || undefined}
      aria-hidden={!visible}
    >
      <div className="chat-workspace-strip__section-reveal-inner">
        {content}
      </div>
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
        <div className="chat-workspace-strip__scroll" ref={stripStackRef}>
          <WorkspaceCard
            id="open"
            title="Open"
            icon={<LayoutPanelTop size={12} strokeWidth={2.25} />}
            open={openPanels.open}
            onToggle={handleTogglePanel}
            measureRef={(node) => setPanelFrameRef("open", node)}
            headerTrailing={
              <SectionToggles
                sections={sections}
                onToggleSection={handleToggleSection}
              />
            }
            headerOnly
          />

          {hasActivity &&
            renderReveal(
              sections.activity,
              <WorkspaceCard
                id="activity"
                title="Activity"
                icon={<ActivityIcon size={12} strokeWidth={2.25} />}
                open={openPanels.activity}
                onToggle={handleTogglePanel}
                measureRef={(node) => setPanelFrameRef("activity", node)}
                onOpenHistory={
                  displayHiddenDoneCount > 0
                    ? () => setHistorySection("done")
                    : undefined
                }
                historyLabel={`View all activity (${displayDoneTasks.length})`}
              >
                {displayRunningTasks.length > 0 && (
                  <TasksList tasks={displayRunningTasks} />
                )}
                {displayRunningTasks.length > 0 &&
                  displayVisibleDoneTasks.length > 0 && (
                    <div className="chat-workspace-strip__activity-done-label">
                      <span className="chat-workspace-strip__card-title">
                        <span
                          className="chat-workspace-strip__card-title-icon"
                          aria-hidden="true"
                        >
                          <Check size={12} strokeWidth={2.25} />
                        </span>
                        Done
                      </span>
                    </div>
                  )}
                {displayVisibleDoneTasks.length > 0 && (
                  <TasksList tasks={displayVisibleDoneTasks} />
                )}
              </WorkspaceCard>,
            )}

          {hasFiles &&
            renderReveal(
              sections.files,
              <WorkspaceCard
                id="files"
                title="Files"
                icon={<FolderClosed size={12} strokeWidth={2.25} />}
                open={openPanels.files}
                onToggle={handleTogglePanel}
                measureRef={(node) => setPanelFrameRef("files", node)}
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
              sections.schedule,
              <WorkspaceCard
                id="schedule"
                title="Schedule"
                icon={<CalendarClock size={12} strokeWidth={2.25} />}
                open={openPanels.schedule}
                onToggle={handleTogglePanel}
                measureRef={(node) => setPanelFrameRef("schedule", node)}
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
