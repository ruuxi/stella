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
import {
  ChevronDown,
  Activity as ActivityIcon,
  FolderClosed,
  CalendarClock,
  LayoutPanelTop,
} from "lucide-react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { useConversationSchedules } from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import {
  extractTasksFromActivities,
  getTaskDisplayText,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { deriveConversationFiles } from "@/shell/display/derive-conversation-files";
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
  chatWorkspaceStripStore,
  useChatWorkspaceStripStore,
  type WorkspaceStripSection,
  type WorkspaceStripSections,
} from "./chat-workspace-strip-store";
import "./chat-workspace-strip.css";

const NOW_VISIBLE = 4;
const DONE_VISIBLE = 4;
const FILES_VISIBLE = 5;
const UPNEXT_VISIBLE = 3;
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
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  headerTrailing?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggleOpen = () => setOpen((v) => !v);
  return (
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
      {open && <div className="chat-workspace-strip__card-body">{children}</div>}
    </section>
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
            <span className="chat-workspace-strip__row-label">{label}</span>
            {task.status === "running" && (
              <span className="chat-workspace-strip__row-meta">Working</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type ChatWorkspaceStripProps = {
  forceHidden?: boolean;
};

export function ChatWorkspaceStrip({
  forceHidden = false,
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
        })
        .slice(0, DONE_VISIBLE),
    [allTasks],
  );

  const files = useMemo(
    () => deriveConversationFiles(filesFeed.files).slice(0, FILES_VISIBLE),
    [filesFeed.files],
  );

  const upNext = useMemo(() => schedules.slice(0, UPNEXT_VISIBLE), [schedules]);

  const hasActivity = runningTasks.length > 0 || doneTasks.length > 0;
  const hasFiles = files.length > 0;
  const hasSchedule = upNext.length > 0;

  const nowMs = Date.now();
  const hidden = panelOpen || forceHidden || !stripVisible;
  const showActivity = sections.activity && hasActivity;
  const showFiles = sections.files && hasFiles;
  const showSchedule = sections.schedule && hasSchedule;

  return (
    <aside
      className={`chat-workspace-strip${hidden ? " chat-workspace-strip--hidden" : ""}`}
      aria-label="Workspace"
      aria-hidden={hidden}
    >
      <div className="chat-workspace-strip__inner">
        <div className="chat-workspace-strip__scroll">
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

          {showActivity && (
            <WorkspaceCard
              title="Activity"
              icon={<ActivityIcon size={12} strokeWidth={2.25} />}
            >
              {runningTasks.length > 0 && (
                <>
                  <div className="chat-workspace-strip__subhead">Now</div>
                  <TasksList tasks={runningTasks} />
                </>
              )}
              {doneTasks.length > 0 && (
                <>
                  <div className="chat-workspace-strip__subhead">Done</div>
                  <TasksList tasks={doneTasks} />
                </>
              )}
            </WorkspaceCard>
          )}

          {showFiles && (
            <WorkspaceCard
              title="Files"
              icon={<FolderClosed size={12} strokeWidth={2.25} />}
            >
              <ul className="chat-workspace-strip__list">
                {files.map((file) => (
                  <li
                    key={file.path}
                    className="chat-workspace-strip__row"
                    title={file.path}
                  >
                    <span className="chat-workspace-strip__file-name">
                      {basenameOf(file.path)}
                    </span>
                  </li>
                ))}
              </ul>
            </WorkspaceCard>
          )}

          {showSchedule && (
            <WorkspaceCard
              title="Schedule"
              icon={<CalendarClock size={12} strokeWidth={2.25} />}
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
            </WorkspaceCard>
          )}
        </div>
      </div>
    </aside>
  );
}
