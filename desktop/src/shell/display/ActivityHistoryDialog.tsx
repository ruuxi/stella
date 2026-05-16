/**
 * Full-list "See all" dialog opened from the chat home overview
 * (`ChatHomeOverview.tsx`). Three sections share the same dialog
 * (Completed / Up next / Recent files) with a search field at the top.
 *
 * Two performance properties matter here, both addressing the user's
 * "shouldn't load all up front" concern:
 *
 *   1. The list is virtualized with `@legendapp/list/react` so even if
 *      the derived dataset has hundreds of rows, only the visible window
 *      is mounted to the DOM.
 *
 *   2. The Completed and Recent files sections page strictly older
 *      events directly from SQLite via `useConversationHistoryPager`
 *      (IPC `localChat:listEventsBefore`). The dialog re-derives tasks
 *      and files from `events + extras` so the user can scroll back
 *      past the renderer's ~500-event window into real history.
 *
 * Schedules are always fetched live as a small bounded list and don't
 * need pagination.
 */

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import { Dialog } from "@/ui/dialog";
import {
  extractTasksFromActivities,
  getTaskDisplayText,
  type EventRecord,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { useConversationHistoryPager } from "@/app/chat/hooks/use-conversation-history-pager";
import type { ScheduleEntry } from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { DisplayTabIcon } from "./icons";
import { basenameOf } from "./path-to-viewer";
import { displayTabKindForPayload } from "./payload-to-tab-spec";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "./derive-conversation-files";
import "./activity-history-dialog.css";

export type ActivityHistorySection = "done" | "upNext" | "files";

/**
 * Files section row variant. Kept exported so the inline overview can
 * pass its own pre-derived entries when not paging from SQLite — the
 * dialog still re-derives from raw events while open.
 */
export type ActivityHistoryFile = ConversationFileEntry;

const SECTION_TITLES: Record<ActivityHistorySection, string> = {
  done: "Completed",
  upNext: "Up next",
  files: "Recent files",
};

const SECTION_PLACEHOLDERS: Record<ActivityHistorySection, string> = {
  done: "Search completed",
  upNext: "Search scheduled",
  files: "Search files",
};

const SECTION_EMPTY: Record<ActivityHistorySection, string> = {
  done: "Nothing completed yet.",
  upNext: "Nothing scheduled.",
  files: "No files yet.",
};

const taskBadge = (task: TaskItem): string => {
  switch (task.status) {
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

const taskLabel = (task: TaskItem): string =>
  (getTaskDisplayText(task) || task.description || "").trim();

type DoneListItem = { kind: "done"; task: TaskItem };
type UpNextListItem = { kind: "upNext"; entry: ScheduleEntry };
type FilesListItem = { kind: "files"; entry: ActivityHistoryFile };
type LoadingListItem = { kind: "loading"; id: string };
type ListItem =
  | DoneListItem
  | UpNextListItem
  | FilesListItem
  | LoadingListItem;

export type ActivityHistoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: ActivityHistorySection;
  /**
   * Raw events from the renderer's live conversation feed. Used today
   * only for the "files" section, which still derives from the event
   * stream until Phase 3 splits files onto their own purpose-built feed.
   */
  events: ReadonlyArray<EventRecord>;
  /**
   * Agent-lifecycle activity events (from `useConversationActivity`).
   * The "done" section reads from these so the dialog can scroll back
   * through completed task history without pulling the full event log.
   */
  activities: ReadonlyArray<EventRecord>;
  latestMessageTimestampMs: number | null;
  /** Grow the activity window — called when the dialog hits the end of
   *  the currently loaded Done list. */
  onLoadMoreActivity: () => void;
  hasMoreActivity: boolean;
  isLoadingMoreActivity: boolean;
  /** Live schedule list — already covers everything for the conversation. */
  schedules: ReadonlyArray<ScheduleEntry>;
  conversationId: string | null;
  nowMs: number;
  onOpenSchedule: (entry: ScheduleEntry) => void;
  onOpenFile: (entry: ActivityHistoryFile) => void;
};

export function ActivityHistoryDialog({
  open,
  onOpenChange,
  section,
  events,
  activities,
  latestMessageTimestampMs,
  onLoadMoreActivity,
  hasMoreActivity,
  isLoadingMoreActivity,
  schedules,
  conversationId,
  nowMs,
  onOpenSchedule,
  onOpenFile,
}: ActivityHistoryDialogProps) {
  const [query, setQuery] = useState("");

  // Files pager — still walks the raw event stream until Phase 3 splits
  // files onto their own purpose-built feed. Anchored at the oldest
  // event already in the renderer's window.
  const filesAnchor = useMemo(() => {
    if (events.length === 0) return null;
    const oldest = events[0];
    return {
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
    };
  }, [events]);

  const filesPagerEnabled =
    open && section === "files" && Boolean(conversationId);

  const filesPager = useConversationHistoryPager({
    conversationId,
    anchor: filesAnchor,
    enabled: filesPagerEnabled,
  });

  // Reset search whenever the dialog opens or the section changes — a
  // stale query for "files" sticking around after opening "Completed"
  // reads as a bug. LegendList resets its own scroll on data change.
  useEffect(() => {
    if (!open) return;
    setQuery("");
  }, [open, section]);

  const needle = query.trim().toLowerCase();

  const doneTasks = useMemo<TaskItem[]>(() => {
    if (section !== "done") return [];
    return extractTasksFromActivities([...activities], {
      latestMessageTimestampMs,
    })
      .filter((task) => task.status !== "running")
      .sort((a, b) => {
        const aTime = a.completedAtMs ?? a.lastUpdatedAtMs ?? a.startedAtMs;
        const bTime = b.completedAtMs ?? b.lastUpdatedAtMs ?? b.startedAtMs;
        return bTime - aTime;
      });
  }, [activities, latestMessageTimestampMs, section]);

  // Files section unions live events with the files pager's older extras
  // so the user can scroll back past the renderer's window.
  const filesEvents = useMemo<EventRecord[]>(() => {
    if (section !== "files") return [];
    if (filesPager.extras.length === 0) return [...events];
    return [...filesPager.extras, ...events];
  }, [filesPager.extras, events, section]);

  const files = useMemo<ActivityHistoryFile[]>(() => {
    if (section !== "files") return [];
    return deriveConversationFiles(filesEvents);
  }, [filesEvents, section]);

  const filteredDone = useMemo(() => {
    if (!needle) return doneTasks;
    return doneTasks.filter((task) =>
      taskLabel(task).toLowerCase().includes(needle),
    );
  }, [doneTasks, needle]);

  const filteredSchedules = useMemo(() => {
    if (!needle) return schedules;
    return schedules.filter((entry) =>
      entry.name.toLowerCase().includes(needle),
    );
  }, [schedules, needle]);

  const filteredFiles = useMemo(() => {
    if (!needle) return files;
    return files.filter((entry) =>
      entry.path.toLowerCase().includes(needle),
    );
  }, [files, needle]);

  const listItems = useMemo<ListItem[]>(() => {
    if (section === "done") {
      const rows: ListItem[] = filteredDone.map((task) => ({
        kind: "done",
        task,
      }));
      if (hasMoreActivity || isLoadingMoreActivity) {
        rows.push({ kind: "loading", id: "pager-loading" });
      }
      return rows;
    }
    if (section === "upNext") {
      return filteredSchedules.map((entry) => ({ kind: "upNext", entry }));
    }
    const rows: ListItem[] = filteredFiles.map((entry) => ({
      kind: "files",
      entry,
    }));
    if (filesPager.hasMore || filesPager.isLoading) {
      rows.push({ kind: "loading", id: "pager-loading" });
    }
    return rows;
  }, [
    filesPager.hasMore,
    filesPager.isLoading,
    filteredDone,
    filteredFiles,
    filteredSchedules,
    hasMoreActivity,
    isLoadingMoreActivity,
    section,
  ]);

  const totalForSection =
    section === "done"
      ? doneTasks.length
      : section === "upNext"
        ? schedules.length
        : files.length;

  const empty =
    listItems.length === 0 ||
    (listItems.length === 1 && listItems[0].kind === "loading");

  const renderItem = ({ item }: LegendListRenderItemProps<ListItem>) => {
    if (item.kind === "done") {
      const { task } = item;
      return (
        <div
          className="activity-history-dialog__row"
          data-status={task.status}
        >
          <span className="activity-history-dialog__row-text">
            {taskLabel(task)}
          </span>
          <span className="activity-history-dialog__row-meta">
            {taskBadge(task)}
          </span>
        </div>
      );
    }
    if (item.kind === "upNext") {
      const { entry } = item;
      return (
        <div className="activity-history-dialog__row">
          <button
            type="button"
            className="activity-history-dialog__row-button"
            onClick={() => onOpenSchedule(entry)}
          >
            <span className="activity-history-dialog__row-text">
              {entry.name}
            </span>
            <span className="activity-history-dialog__row-meta">
              {formatNextRun(entry.nextRunAtMs, nowMs)}
            </span>
          </button>
        </div>
      );
    }
    if (item.kind === "files") {
      const { entry } = item;
      return (
        <div className="activity-history-dialog__row">
          <button
            type="button"
            className="activity-history-dialog__row-button activity-history-dialog__row-button--file"
            onClick={() => onOpenFile(entry)}
            title={entry.path}
          >
            <DisplayTabIcon
              kind={displayTabKindForPayload(entry.payload)}
              size={16}
            />
            <span className="activity-history-dialog__row-text">
              {basenameOf(entry.path)}
            </span>
            <span className="activity-history-dialog__row-meta activity-history-dialog__row-meta--path">
              {entry.path}
            </span>
          </button>
        </div>
      );
    }
    return (
      <div
        className="activity-history-dialog__loading"
        role="status"
        aria-live="polite"
      >
        Loading earlier history…
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="md" fit className="activity-history-dialog">
        <Dialog.Header>
          <Dialog.Title>{SECTION_TITLES[section]}</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Header>
        <div className="activity-history-dialog__search">
          <Search size={14} aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={SECTION_PLACEHOLDERS[section]}
            spellCheck={false}
            autoFocus
            aria-label={SECTION_PLACEHOLDERS[section]}
          />
          {query && (
            <button
              type="button"
              className="activity-history-dialog__search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Dialog.Body>
          {empty ? (
            <div className="activity-history-dialog__empty-wrap">
              <p className="activity-history-dialog__empty">
                {needle
                  ? `No matches in ${totalForSection.toLocaleString()}.`
                  : SECTION_EMPTY[section]}
              </p>
            </div>
          ) : (
            <div className="activity-history-dialog__scroll">
              <LegendList<ListItem>
                data={listItems}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                estimatedItemSize={36}
                recycleItems
                onEndReached={
                  section === "done"
                    ? onLoadMoreActivity
                    : section === "files"
                      ? filesPager.loadMore
                      : undefined
                }
                onEndReachedThreshold={0.6}
                style={{ height: "100%", width: "100%" }}
              />
            </div>
          )}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}

const keyExtractor = (item: ListItem): string => {
  switch (item.kind) {
    case "done":
      return `done:${item.task.id}`;
    case "upNext":
      return `up:${item.entry.kind}:${item.entry.id}`;
    case "files":
      return `file:${item.entry.path}`;
    case "loading":
      return item.id;
  }
};
