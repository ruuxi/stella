/**
 * Right-aligned workspace strip rendered next to the active chat
 * conversation surface (NOT on the home content, and NOT when the
 * display sidebar is open).
 *
 * Each section is its own outlined card (rounded corners, 1px subtle
 * border, no painted fill) with a header row that carries the title +
 * a chevron collapse affordance. Cards stack vertically; empty cards
 * are omitted entirely.
 *
 * This is still a visualization scaffold — it consumes the same data
 * the Chat-tab `ChatHomeOverview` consumes, but renders it as discrete
 * outlined cards so we can iterate on the workspace-strip shape
 * without touching the existing Chat tab body.
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
import "./home-workspace-mock.css";

const NOW_VISIBLE = 4;
const DONE_VISIBLE = 4;
const FILES_VISIBLE = 5;
const UPNEXT_VISIBLE = 3;

type TabOpenOption = {
  id: string;
  label: string;
  kind: DisplayTabKind;
  open: () => void;
};

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

function MockCard({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`home-workspace-mock__card${open ? "" : " home-workspace-mock__card--collapsed"}`}
    >
      <button
        type="button"
        className="home-workspace-mock__card-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="home-workspace-mock__card-title">
          <span
            className="home-workspace-mock__card-title-icon"
            aria-hidden="true"
          >
            {icon}
          </span>
          {title}
        </span>
        <ChevronDown
          className="home-workspace-mock__card-chevron"
          size={14}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open && <div className="home-workspace-mock__card-body">{children}</div>}
    </section>
  );
}

function TasksList({ tasks }: { tasks: ReadonlyArray<TaskItem> }) {
  return (
    <ul className="home-workspace-mock__list">
      {tasks.map((task) => {
        const label = (getTaskDisplayText(task) || task.description).trim();
        return (
          <li
            key={task.id}
            className="home-workspace-mock__row"
            data-status={task.status === "running" ? "now" : "done"}
          >
            <span className="home-workspace-mock__row-label">{label}</span>
            {task.status === "running" && (
              <span className="home-workspace-mock__row-meta">Working</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function HomeWorkspaceMock() {
  const { panelOpen } = useDisplayPanelLayout();
  const chat = useChatRuntime();
  const { state } = useUiState();

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const liveTasks = chat.conversation.streaming.liveTasks ?? [];
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

  const upNext = useMemo(
    () => schedules.slice(0, UPNEXT_VISIBLE),
    [schedules],
  );

  // Hide the entire strip while the real display sidebar is open — the
  // user is already looking at the workspace there, no need to double
  // up.
  if (panelOpen) return null;

  const hasActivity = runningTasks.length > 0 || doneTasks.length > 0;
  const hasFiles = files.length > 0;
  const hasSchedule = upNext.length > 0;

  const nowMs = Date.now();

  return (
    <aside className="home-workspace-mock" aria-label="Workspace">
      <div className="home-workspace-mock__scroll">
        <MockCard
          title="Open"
          icon={<LayoutPanelTop size={12} strokeWidth={2.25} />}
        >
          <ul className="home-workspace-mock__tab-list">
            {TAB_OPTIONS.map((opt) => (
              <li key={opt.id}>
                <button
                  type="button"
                  className="home-workspace-mock__tab-button"
                  onClick={() => {
                    if (displayTabs.getTabListSnapshot().tabs.some((t) => t.id === opt.id)) {
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
        </MockCard>

        {hasActivity && (
          <MockCard
            title="Activity"
            icon={<ActivityIcon size={12} strokeWidth={2.25} />}
          >
            {runningTasks.length > 0 && (
              <>
                <div className="home-workspace-mock__subhead">Now</div>
                <TasksList tasks={runningTasks} />
              </>
            )}
            {doneTasks.length > 0 && (
              <>
                <div className="home-workspace-mock__subhead">Done</div>
                <TasksList tasks={doneTasks} />
              </>
            )}
          </MockCard>
        )}

        {hasFiles && (
          <MockCard
            title="Files"
            icon={<FolderClosed size={12} strokeWidth={2.25} />}
          >
            <ul className="home-workspace-mock__list">
              {files.map((file) => (
                <li
                  key={file.path}
                  className="home-workspace-mock__row"
                  title={file.path}
                >
                  <span className="home-workspace-mock__file-name">
                    {basenameOf(file.path)}
                  </span>
                </li>
              ))}
            </ul>
          </MockCard>
        )}

        {hasSchedule && (
          <MockCard
            title="Schedule"
            icon={<CalendarClock size={12} strokeWidth={2.25} />}
          >
            <ul className="home-workspace-mock__list">
              {upNext.map((entry) => (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="home-workspace-mock__row"
                >
                  <span className="home-workspace-mock__row-label">
                    {entry.name.trim()}
                  </span>
                  <span className="home-workspace-mock__row-meta">
                    {formatNextRun(entry.nextRunAtMs, nowMs)}
                  </span>
                </li>
              ))}
            </ul>
          </MockCard>
        )}
      </div>
    </aside>
  );
}
