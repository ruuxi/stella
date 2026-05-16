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
 * Ideas are no longer rendered here — they live as a footer dropup on the
 * home content itself (see `desktop/src/app/home/HomeContent.tsx`). On
 * every other route, the Chat tab keeps rendering the live ChatPanelTab
 * (see `default-tabs.tsx`). The route swap happens at the render level,
 * not by closing/reopening the tab — selection and panel state never
 * change just because the user navigates.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Check, Clock } from "lucide-react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { useEdgeFade } from "@/shared/hooks/use-edge-fade";
import {
  ActivityHistoryDialog,
  type ActivityHistorySection,
} from "./ActivityHistoryDialog";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "../../../../runtime/contracts/file-changes.js";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { displayTabs } from "./tab-store";
import {
  displayTabKindForPayload,
  payloadToTabSpec,
} from "./payload-to-tab-spec";
import {
  basenameOf,
} from "./path-to-viewer";
import { DisplayTabIcon } from "./icons";
import {
  extractTasksFromEvents,
  getTaskDisplayText,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { buildPayloadFromBarePath } from "@/app/chat/lib/derive-turn-resource";
import {
  useConversationSchedules,
  type ScheduleEntry,
} from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "../../../../runtime/kernel/shared/scheduling";
import "./chat-home-overview.css";

const FILES_DEFAULT_VISIBLE = 5;
const DONE_DEFAULT_VISIBLE = 4;
const UP_NEXT_DEFAULT_VISIBLE = 3;
/**
 * Upper bound on the file list materialised from the conversation. Events
 * themselves are already capped at ~500 (see `MAX_RENDERED_EVENTS`), so a
 * generous cap here only matters for the "See all" dialog — inline we
 * still render at most `FILES_DEFAULT_VISIBLE`.
 */
const FILES_TOTAL_CAP = 500;
const NEXT_RUN_TICK_MS = 30_000;
/**
 * How many cheap-model progress phrases stay on screen per running task.
 * The hook still keeps a longer rolling buffer in memory (so the count
 * can grow if we ever want history-on-hover), but the rendered list is
 * capped here so the feed never visually grows past N rows — older
 * phrases fall off the top deterministically without depending on
 * scrollable max-height behaviour inside the display sidebar.
 */
const TASK_PROGRESS_VISIBLE = 4;
/**
 * Hard character cap for activity row descriptions (Now / Done / Up next).
 * The width-based CSS ellipsis still applies on top as a safety net for
 * very narrow panels, but the character cap keeps the visual rhythm of
 * the list consistent regardless of how wide the display sidebar is.
 */
const MAX_TASK_TITLE_CHARS = 45;

const truncateTitle = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_TASK_TITLE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TASK_TITLE_CHARS - 1).trimEnd()}…`;
};

type FileEntry = {
  path: string;
  timestamp: number;
  payload: DisplayTabPayload;
};

const resolvedPathForChange = (record: FileChangeRecord): string | null => {
  if (record.kind.type === "delete") return null;
  const path =
    record.kind.type === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  if (!path || !path.startsWith("/")) return null;
  return path;
};

const taskLineFor = (task: TaskItem): string => {
  return truncateTitle(getTaskDisplayText(task) || task.description);
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
 * Sub-list rendered under a running task. Each entry is a 3-6 word phrase
 * the cheap summarizer returned for the agent's most recent activity.
 *
 * The list always shows at most `TASK_PROGRESS_VISIBLE` rows in a fixed
 * column — newer entries push the oldest one off the top. Previously
 * relied on `max-height` + `overflow-y: auto` + an autoscroll effect,
 * but inside the display sidebar's grid layout the max-height was not
 * always respected and the older entries visually piled up behind the
 * mask, reading as overlapping rows. A hard render-time slice removes
 * the failure mode entirely.
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

function TaskRow({
  task,
  summaries,
}: {
  task: TaskItem;
  summaries: ReadonlyArray<ProgressSummary>;
}) {
  return (
    <li
      className="chat-home-overview__task"
      data-status={task.status}
    >
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
          and status badge tell the whole story — the older progress
          phrases just add noise to the history. */}
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
        className="chat-home-overview__task-row chat-home-overview__schedule-trigger"
        onClick={() => onOpen(entry)}
      >
        <span className="chat-home-overview__task-text">
          {truncateTitle(entry.name)}
        </span>
        <span className="chat-home-overview__task-status">
          {formatNextRun(entry.nextRunAtMs, nowMs)}
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

function SubgroupLabel({
  children,
  icon,
}: {
  children: string;
  icon: ReactNode;
}) {
  return (
    <li
      className="chat-home-overview__subgroup-label"
      role="presentation"
      aria-hidden="true"
    >
      <span
        className="chat-home-overview__subgroup-label-icon"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="chat-home-overview__subgroup-label-text">
        {children}
      </span>
    </li>
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
    <li className="chat-home-overview__show-more-row">
      <button
        type="button"
        className="chat-home-overview__show-more"
        onClick={onClick}
      >
        See all ({total})
      </button>
    </li>
  );
}

export function ChatHomeOverview() {
  const chat = useChatRuntime();
  const { state } = useUiState();
  const liveTasks = chat.conversation.streaming.liveTasks ?? [];
  const events = chat.conversation.events;
  const summariesByAgent = chat.conversation.streaming.taskProgressSummaries;
  const schedules = useConversationSchedules(state.conversationId);

  // Activity + Recent files each get their own hidden-scrollbar +
  // edge-fade scroller. `useEdgeFade` toggles `data-at-start` /
  // `data-at-end` on the element so the mask drops on the edge the
  // user has scrolled to (see `chat-home-overview.css`).
  const activityScrollRef = useRef<HTMLDivElement | null>(null);
  const filesScrollRef = useRef<HTMLDivElement | null>(null);
  useEdgeFade(activityScrollRef, { axis: "vertical" });
  useEdgeFade(filesScrollRef, { axis: "vertical" });

  const [historySection, setHistorySection] =
    useState<ActivityHistorySection | null>(null);

  const allTasks = useMemo(() => {
    const persisted = extractTasksFromEvents(events);
    return mergeFooterTasks(persisted, liveTasks);
  }, [events, liveTasks]);

  const runningTasks = useMemo(() => {
    return [...allTasks]
      .filter((task) => task.status === "running")
      .sort((a, b) => {
        const aTime = a.lastUpdatedAtMs ?? a.startedAtMs;
        const bTime = b.lastUpdatedAtMs ?? b.startedAtMs;
        return bTime - aTime;
      });
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

  const [openScheduleEntry, setOpenScheduleEntry] = useState<ScheduleEntry | null>(
    null,
  );
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !state.conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, state.conversationId)];
  }, [openScheduleEntry, state.conversationId]);

  const allFiles = useMemo<FileEntry[]>(() => {
    const seen = new Map<string, FileEntry>();

    for (const event of events) {
      const payload = event.payload as
        | { fileChanges?: unknown; producedFiles?: unknown }
        | undefined;
      if (!payload || typeof payload !== "object") continue;

      const fileChanges = isFileChangeRecordArray(payload.fileChanges)
        ? payload.fileChanges
        : [];
      const produced = isProducedFileRecordArray(payload.producedFiles)
        ? payload.producedFiles
        : [];

      for (const record of [...fileChanges, ...produced]) {
        const path = resolvedPathForChange(record);
        if (!path) continue;
        const filePayload = buildPayloadFromBarePath(path, event.timestamp, {
          produced: true,
        });
        if (!filePayload || !isDisplayTabPayload(filePayload)) continue;
        // Most-recent occurrence wins so the timestamp reflects the
        // latest activity for that file.
        seen.set(path, {
          path,
          timestamp: event.timestamp,
          payload: filePayload,
        });
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, FILES_TOTAL_CAP);
  }, [events]);

  const visibleFiles = allFiles.slice(0, FILES_DEFAULT_VISIBLE);
  const hiddenFilesCount = allFiles.length - visibleFiles.length;

  const handleOpenFile = (entry: FileEntry) => {
    displayTabs.openTab(payloadToTabSpec(entry.payload));
  };

  const activityIsEmpty =
    runningTasks.length === 0 &&
    doneTasks.length === 0 &&
    visibleSchedules.length === 0;

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
            <ul className="chat-home-overview__tasks">
              {runningTasks.length > 0 && (
                <>
                  <SubgroupLabel icon={<Activity size={12} strokeWidth={2.25} />}>
                    Now
                  </SubgroupLabel>
                  {runningTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      summaries={summariesByAgent.get(task.id) ?? []}
                    />
                  ))}
                </>
              )}

              {doneTasks.length > 0 && (
                <>
                  <SubgroupLabel icon={<Check size={12} strokeWidth={2.5} />}>
                    Done
                  </SubgroupLabel>
                  {/*
                   * Group container owns the soft glowing left bar
                   * (see `.chat-home-overview__group--done` in
                   * chat-home-overview.css). The bar is a single
                   * `::before` pseudo-element spanning the group's
                   * height, so it naturally grows as more Done rows
                   * stack inside it.
                   */}
                  <li
                    className="chat-home-overview__group chat-home-overview__group--done"
                    role="presentation"
                  >
                    <ul className="chat-home-overview__group-inner">
                      {visibleDone.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          summaries={summariesByAgent.get(task.id) ?? []}
                        />
                      ))}
                    </ul>
                  </li>
                  {hiddenDoneCount > 0 && (
                    <SeeAllButton
                      total={doneTasks.length}
                      onClick={() => setHistorySection("done")}
                    />
                  )}
                </>
              )}

              {visibleSchedules.length > 0 && (
                <>
                  <SubgroupLabel icon={<Clock size={12} strokeWidth={2.25} />}>
                    Up next
                  </SubgroupLabel>
                  {visibleSchedules.map((entry) => (
                    <ScheduleRow
                      key={`${entry.kind}:${entry.id}`}
                      entry={entry}
                      nowMs={nowMs}
                      onOpen={setOpenScheduleEntry}
                    />
                  ))}
                  {hiddenScheduleCount > 0 && (
                    <SeeAllButton
                      total={schedules.length}
                      onClick={() => setHistorySection("upNext")}
                    />
                  )}
                </>
              )}
            </ul>
          )}
        </div>
      </section>

      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Recent files</h3>
        <div
          ref={filesScrollRef}
          className="chat-home-overview__section-body"
        >
          {allFiles.length === 0 ? (
            <p className="chat-home-overview__empty">
              Files Stella changes or creates will show up here.
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
                <SeeAllButton
                  total={allFiles.length}
                  onClick={() => setHistorySection("files")}
                />
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
        doneTasks={doneTasks}
        schedules={schedules}
        files={allFiles}
        nowMs={nowMs}
        onOpenSchedule={(entry) => {
          // Hand the row off to the existing schedule manage dialog so
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
