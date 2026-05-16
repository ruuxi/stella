/**
 * Full-list "See all" dialog opened from the chat home overview
 * (`ChatHomeOverview.tsx`). Each section in the overview caps how many
 * rows it shows inline; this dialog renders the full list for one
 * section at a time with a search field at the top.
 *
 * Three sections share the same dialog so the surface feels uniform:
 *   - `done`    — every completed/failed/canceled task for the
 *                 current conversation
 *   - `upNext`  — every scheduled cron/heartbeat for the current
 *                 conversation (clicking a row opens the schedule
 *                 manage dialog, same as the inline row)
 *   - `files`   — every file Stella touched in this conversation
 *
 * Search is a plain substring match against the row label. The data
 * sets are bounded (events are capped to ~500 in the renderer) so an
 * in-memory filter is cheap and avoids a round-trip through SQLite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Dialog } from "@/ui/dialog";
import { useEdgeFade } from "@/shared/hooks/use-edge-fade";
import {
  getTaskDisplayText,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
import type { ScheduleEntry } from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { DisplayTabIcon } from "./icons";
import { basenameOf } from "./path-to-viewer";
import { displayTabKindForPayload } from "./payload-to-tab-spec";
import "./activity-history-dialog.css";

export type ActivityHistorySection = "done" | "upNext" | "files";

export type ActivityHistoryFile = {
  path: string;
  timestamp: number;
  payload: DisplayTabPayload;
};

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

export type ActivityHistoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: ActivityHistorySection;
  doneTasks: ReadonlyArray<TaskItem>;
  schedules: ReadonlyArray<ScheduleEntry>;
  files: ReadonlyArray<ActivityHistoryFile>;
  nowMs: number;
  onOpenSchedule: (entry: ScheduleEntry) => void;
  onOpenFile: (entry: ActivityHistoryFile) => void;
};

export function ActivityHistoryDialog({
  open,
  onOpenChange,
  section,
  doneTasks,
  schedules,
  files,
  nowMs,
  onOpenSchedule,
  onOpenFile,
}: ActivityHistoryDialogProps) {
  const [query, setQuery] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEdgeFade(scrollerRef, { axis: "vertical" });

  // Reset search and scroll whenever the dialog opens or the section
  // changes — a stale query for "files" sticking around after opening
  // "Completed" reads as a bug.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [open, section]);

  const needle = query.trim().toLowerCase();

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

  const totalForSection =
    section === "done"
      ? doneTasks.length
      : section === "upNext"
        ? schedules.length
        : files.length;

  const filteredCount =
    section === "done"
      ? filteredDone.length
      : section === "upNext"
        ? filteredSchedules.length
        : filteredFiles.length;

  const empty = filteredCount === 0;

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
          <div ref={scrollerRef} className="activity-history-dialog__scroll">
            {empty ? (
              <p className="activity-history-dialog__empty">
                {needle
                  ? `No matches in ${totalForSection.toLocaleString()}.`
                  : SECTION_EMPTY[section]}
              </p>
            ) : section === "done" ? (
              <ul className="activity-history-dialog__list">
                {filteredDone.map((task) => (
                  <li
                    key={task.id}
                    className="activity-history-dialog__row"
                    data-status={task.status}
                  >
                    <span className="activity-history-dialog__row-text">
                      {taskLabel(task)}
                    </span>
                    <span className="activity-history-dialog__row-meta">
                      {taskBadge(task)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : section === "upNext" ? (
              <ul className="activity-history-dialog__list">
                {filteredSchedules.map((entry) => (
                  <li
                    key={`${entry.kind}:${entry.id}`}
                    className="activity-history-dialog__row"
                  >
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
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="activity-history-dialog__list">
                {filteredFiles.map((entry) => (
                  <li
                    key={entry.path}
                    className="activity-history-dialog__row"
                  >
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
