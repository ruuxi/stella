/**
 * Display-tab body shown for the "Chat" tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so the Chat display tab cannot host a duplicate
 * conversation — there's nothing useful to see there. Instead we surface
 * what is actually useful at a glance from the workspace panel:
 *
 *   - Activity: a single time-ordered strip of running, completed, and
 *     upcoming agent work for this conversation. Internal subgroups are
 *     `NOW`, `DONE` (capped, with show-more), and `UP NEXT` (scheduled
 *     cron jobs + heartbeat fires for this conversation, capped).
 *   - Recent files: the assistant's recent file changes for this
 *     conversation, capped, with show-more.
 *
 * Suggestions are no longer rendered here or on the home canvas — they
 * live in the workspace strip's Open panel. On every other route, the Chat
 * tab keeps rendering the live ChatPanelTab (see `default-tabs.tsx`).
 * The route swap happens at the render level,
 * not by closing/reopening the tab — selection and panel state never
 * change just because the user navigates.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Activity, Check, Clock } from "lucide-react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { useEdgeFade } from "@/shared/hooks/use-edge-fade";
import {
  ActivityHistoryDialog,
  type ActivityHistorySection,
} from "./ActivityHistoryDialog";
import { displayTabs } from "./tab-store";
import {
  displayTabKindForPayload,
  payloadToTabSpec,
} from "./payload-to-tab-spec";
import { basenameOf } from "./path-to-viewer";
import { DisplayTabIcon } from "./icons";
import {
  extractTasksFromActivities,
  getTaskDisplayText,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "./derive-conversation-files";
import {
  useConversationSchedules,
  type ScheduleEntry,
} from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "../../../../runtime/kernel/shared/scheduling";
import { ChatIllustration } from "./illustrations/ChatIllustration";
import "./chat-home-overview.css";

const FILES_DEFAULT_VISIBLE = 5;
const DONE_DEFAULT_VISIBLE = 4;
const UP_NEXT_DEFAULT_VISIBLE = 5;
const NEXT_RUN_TICK_MS = 30_000;
const EMPTY_TASKS: TaskItem[] = [];
/**
 * Rendered cap on per-task progress phrases. The hook keeps a longer
 * rolling buffer in memory; the visible slice is bounded here so older
 * phrases fall off the top deterministically without depending on
 * scrollable max-height inside the display sidebar.
 */
const TASK_PROGRESS_VISIBLE = 4;

type FileEntry = ConversationFileEntry;

const taskLineFor = (task: TaskItem): string => {
  return (getTaskDisplayText(task) || task.description).trim();
};

const taskBadgeFor = (task: TaskItem): string => {
  switch (task.status) {
    case "running":
      return "Working";
    case "completed":
      return "Done";
    case "error":
      return "Failed";
    case "canceled":
      return "Stopped";
    default:
      return "";
  }
};

type ProgressSummary = { id: string; text: string; createdAt: number };

/**
 * Live "now" used to format relative next-run badges. Refreshes on a slow
 * interval only while at least one schedule row is rendered, so an empty
 * UP NEXT list costs nothing.
 */
function useNextRunTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), NEXT_RUN_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Sub-list under a running task: short cheap-summarizer phrases of what
 * the agent is currently doing. Capped at TASK_PROGRESS_VISIBLE; older
 * phrases fall off the top. Recency cue is position (last row) and
 * color (--text-base vs --text-weak) — no shimmer, no border-left.
 */
function TaskProgressFeed({
  summaries,
  isRunning,
}: {
  summaries: ReadonlyArray<ProgressSummary>;
  isRunning: boolean;
}) {
  const visible = summaries.slice(-TASK_PROGRESS_VISIBLE);
  return (
    <ol
      className={`chat-home-overview__task-feed${
        isRunning ? "" : " chat-home-overview__task-feed--idle"
      }`}
    >
      {visible.map((summary) => (
        <li key={summary.id} className="chat-home-overview__task-feed-item">
          {summary.text}
        </li>
      ))}
    </ol>
  );
}

function TaskRow({
  task,
  summaries,
}: {
  task: TaskItem;
  summaries: ReadonlyArray<ProgressSummary>;
}) {
  return (
    <li className="chat-home-overview__task" data-status={task.status}>
      <div className="chat-home-overview__task-row">
        <span className="chat-home-overview__task-text">
          {taskLineFor(task)}
        </span>
        <span className="chat-home-overview__task-status">
          {taskBadgeFor(task)}
        </span>
      </div>
      {/* Per-task progress feed is only meaningful while the task is
          actively running. Once it's Done/Failed/Stopped, the description
          and status badge tell the whole story. */}
      {task.status === "running" && summaries.length > 0 && (
        <TaskProgressFeed summaries={summaries} isRunning />
      )}
    </li>
  );
}

function ScheduleRow({
  entry,
  nowMs,
  onOpen,
}: {
  entry: ScheduleEntry;
  nowMs: number;
  onOpen: (entry: ScheduleEntry) => void;
}) {
  return (
    <li className="chat-home-overview__task" data-status="scheduled">
      <button
        type="button"
        className="chat-home-overview__schedule-trigger"
        onClick={() => onOpen(entry)}
      >
        <span className="chat-home-overview__task-row">
          <span className="chat-home-overview__task-text">
            {entry.name.trim()}
          </span>
          <span className="chat-home-overview__task-status">
            {formatNextRun(entry.nextRunAtMs, nowMs)}
          </span>
        </span>
      </button>
    </li>
  );
}

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

/**
 * Subgroup: a real heading + a task list wired together via
 * `aria-labelledby` so screen readers announce which group each row
 * belongs to. The wrapping element is a `<section>` with the heading
 * inside, not an `<li>` with role="presentation".
 */
function Subgroup({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className="chat-home-overview__subgroup"
      aria-labelledby={headingId}
    >
      <h4 id={headingId} className="chat-home-overview__subgroup-label">
        <span
          className="chat-home-overview__subgroup-label-icon"
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className="chat-home-overview__subgroup-label-text">{label}</span>
      </h4>
      {children}
    </section>
  );
}

function SeeAllButton({
  total,
  onClick,
}: {
  total: number;
  onClick: () => void;
}) {
  return (
    <div className="chat-home-overview__show-more-row">
      <button
        type="button"
        className="chat-home-overview__show-more"
        onClick={onClick}
      >
        See all ({total})
      </button>
    </div>
  );
}

export function ChatHomeOverview() {
  const chat = useChatRuntime();
  const { state } = useUiState();
  const liveTasks = chat.conversation.streaming.liveTasks ?? EMPTY_TASKS;
  const activity = chat.conversation.activity;
  const filesFeed = chat.conversation.files;
  const summariesByAgent = chat.conversation.streaming.taskProgressSummaries;
  const schedules = useConversationSchedules(state.conversationId);

  const activityScrollRef = useRef<HTMLDivElement | null>(null);
  const filesScrollRef = useRef<HTMLDivElement | null>(null);
  useEdgeFade(activityScrollRef, { axis: "vertical" });
  useEdgeFade(filesScrollRef, { axis: "vertical" });

  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);

  const allTasks = useMemo(() => {
    const persisted = extractTasksFromActivities(activity.activities, {
      latestMessageTimestampMs: activity.latestMessageTimestampMs,
    });
    return mergeFooterTasks(persisted, liveTasks);
  }, [activity.activities, activity.latestMessageTimestampMs, liveTasks]);

  const runningTasks = useMemo(() => {
    return (
      [...allTasks]
        .filter((task) => task.status === "running")
        // Sort by the row's stable start time, NOT lastUpdatedAtMs —
        // otherwise every per-task progress summary bumps the row's
        // updated-at, the sort re-runs, and concurrently-running tasks
        // visibly swap places in the Now group while their feeds tick.
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
    );
  }, [allTasks]);

  const doneTasks = useMemo(() => {
    return [...allTasks]
      .filter((task) => task.status !== "running")
      .sort((a, b) => {
        const aTime = a.completedAtMs ?? a.lastUpdatedAtMs ?? a.startedAtMs;
        const bTime = b.completedAtMs ?? b.lastUpdatedAtMs ?? b.startedAtMs;
        return bTime - aTime;
      });
  }, [allTasks]);

  const visibleDone = doneTasks.slice(0, DONE_DEFAULT_VISIBLE);
  const hiddenDoneCount = doneTasks.length - visibleDone.length;

  const visibleSchedules = schedules.slice(0, UP_NEXT_DEFAULT_VISIBLE);
  const hiddenScheduleCount = schedules.length - visibleSchedules.length;
  // Keep the ticker active whenever the dialog might be showing
  // schedules so its "in 5 min" badges stay live there too.
  const nowMs = useNextRunTicker(
    visibleSchedules.length > 0 || historySection === "upNext",
  );

  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !state.conversationId) return [];
    return [
      scheduleEntryToAffectedRef(openScheduleEntry, state.conversationId),
    ];
  }, [openScheduleEntry, state.conversationId]);

  // Inline view derives from the in-memory file-events window only —
  // the See-all dialog re-derives from the same stream and pages older
  // history through filesFeed.loadOlder on demand.
  const allFiles = useMemo<FileEntry[]>(
    () => deriveConversationFiles(filesFeed.files),
    [filesFeed.files],
  );

  const visibleFiles = allFiles.slice(0, FILES_DEFAULT_VISIBLE);
  const hiddenFilesCount = allFiles.length - visibleFiles.length;

  const handleOpenFile = (entry: FileEntry) => {
    displayTabs.openTab(payloadToTabSpec(entry.payload));
  };

  const activityIsEmpty =
    runningTasks.length === 0 &&
    doneTasks.length === 0 &&
    visibleSchedules.length === 0;
  const overviewIsEmpty = activityIsEmpty && allFiles.length === 0;

  if (overviewIsEmpty) {
    return (
      <div className="chat-home-overview chat-home-overview--empty">
        <div className="chat-home-overview__empty-illustration">
          <ChatIllustration />
        </div>
        <p className="chat-home-overview__empty chat-home-overview__empty--lead">
          Activity and files from this conversation will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-home-overview">
      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Activity</h3>
        <div
          ref={activityScrollRef}
          className="chat-home-overview__section-body"
        >
          {activityIsEmpty ? (
            <p className="chat-home-overview__empty">Nothing in flight.</p>
          ) : (
            <div className="chat-home-overview__subgroups">
              {runningTasks.length > 0 && (
                <Subgroup
                  label="Now"
                  icon={<Activity size={12} strokeWidth={2.25} />}
                >
                  <ul className="chat-home-overview__tasks">
                    {runningTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        summaries={summariesByAgent.get(task.id) ?? []}
                      />
                    ))}
                  </ul>
                </Subgroup>
              )}

              {doneTasks.length > 0 && (
                <Subgroup
                  label="Done"
                  icon={<Check size={12} strokeWidth={2.5} />}
                >
                  <ul className="chat-home-overview__tasks">
                    {visibleDone.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        summaries={summariesByAgent.get(task.id) ?? []}
                      />
                    ))}
                  </ul>
                  {hiddenDoneCount > 0 && (
                    <SeeAllButton
                      total={doneTasks.length}
                      onClick={() => setHistorySection("done")}
                    />
                  )}
                </Subgroup>
              )}

              {visibleSchedules.length > 0 && (
                <Subgroup
                  label="Up next"
                  icon={<Clock size={12} strokeWidth={2.25} />}
                >
                  <ul className="chat-home-overview__tasks">
                    {visibleSchedules.map((entry) => (
                      <ScheduleRow
                        key={`${entry.kind}:${entry.id}`}
                        entry={entry}
                        nowMs={nowMs}
                        onOpen={setOpenScheduleEntry}
                      />
                    ))}
                  </ul>
                  {hiddenScheduleCount > 0 && (
                    <SeeAllButton
                      total={schedules.length}
                      onClick={() => setHistorySection("upNext")}
                    />
                  )}
                </Subgroup>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Recent files</h3>
        <div ref={filesScrollRef} className="chat-home-overview__section-body">
          {allFiles.length === 0 ? (
            <p className="chat-home-overview__empty">
              Files Stella works on will show up here.
            </p>
          ) : (
            <ul className="chat-home-overview__files">
              {visibleFiles.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="chat-home-overview__file"
                    onClick={() => handleOpenFile(entry)}
                    title={entry.path}
                  >
                    <DisplayTabIcon
                      kind={displayTabKindForPayload(entry.payload)}
                      size={18}
                    />
                    <span className="chat-home-overview__file-name">
                      {basenameOf(entry.path)}
                    </span>
                  </button>
                </li>
              ))}
              {hiddenFilesCount > 0 && (
                <li>
                  <SeeAllButton
                    total={allFiles.length}
                    onClick={() => setHistorySection("files")}
                  />
                </li>
              )}
            </ul>
          )}
        </div>
      </section>

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
        conversationId={state.conversationId}
        nowMs={nowMs}
        onOpenSchedule={(entry) => {
          // Hand off to the existing schedule manage dialog so
          // Run-now / Pause / Delete behave identically whether the
          // user came in via the inline row or the "See all" list.
          setOpenScheduleEntry(entry);
        }}
        onOpenFile={(entry) => {
          handleOpenFile(entry);
          setHistorySection(null);
        }}
      />
    </div>
  );
}
