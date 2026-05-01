/**
 * Display-tab body shown for the "Chat" tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so the Chat display tab cannot host a duplicate
 * conversation — there's nothing useful to see there. Instead we surface
 * what is actually useful at a glance from the workspace panel:
 *
 *   - Activity: recent agent task status (running / completed / failed),
 *     using the user-friendly status text the runtime already streams.
 *   - Recent files: every file the assistant changed or produced in this
 *     conversation, clickable to open in its own display tab.
 *
 * On every other route, the Chat tab keeps rendering the live ChatPanelTab
 * (see `default-tabs.tsx`). The route swap happens at the render level,
 * not by closing/reopening the tab — selection and panel state never
 * change just because the user navigates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { usePersonalizedCategories } from "@/app/home/categories";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "@/shared/contracts/file-changes";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { displayTabs } from "./tab-store";
import { payloadToTabSpec } from "./payload-to-tab-spec";
import {
  basenameOf,
  fileArtifactPayloadForPath,
} from "./path-to-viewer";
import { DisplayTabIcon } from "./icons";
import {
  extractTasksFromEvents,
  mergeFooterTasks,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import "./chat-home-overview.css";

const MAX_FILES = 24;

type FileEntry = {
  path: string;
  timestamp: number;
  payload: DisplayPayload;
};

/**
 * Resolve a `FileChangeRecord` into the canonical post-mutation absolute
 * path. Mirrors the small helper in `derive-turn-resource.ts` but stays
 * local so this surface doesn't reach into the chat package's internals.
 */
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
  if (task.status === "running") {
    return task.statusText ?? task.description;
  }
  return task.description;
};

type ProgressSummary = { id: string; text: string; createdAt: number };

/**
 * Sub-list rendered under a running task. Each entry is a 3-6 word phrase
 * the cheap summarizer returned for the agent's most recent activity.
 * Auto-scrolls to the newest entry, hides its scrollbar, and fades the
 * top/bottom edges once the list overflows.
 */
function TaskProgressFeed({
  summaries,
  isRunning,
}: {
  summaries: ReadonlyArray<ProgressSummary>;
  isRunning: boolean;
}) {
  const scrollRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [summaries.length]);

  return (
    <ol
      ref={scrollRef}
      className={`chat-home-overview__task-feed${
        isRunning ? "" : " chat-home-overview__task-feed--idle"
      }`}
    >
      {summaries.map((summary) => (
        <li key={summary.id} className="chat-home-overview__task-feed-item">
          {summary.text}
        </li>
      ))}
    </ol>
  );
}

function IdeasHomeSection() {
  const { state } = useUiState();
  const { onSuggestionClick } = useChatRuntime();
  const categories = usePersonalizedCategories(state.conversationId);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  const selectedCategory = useMemo(() => {
    if (categories.length === 0) return null;
    return (
      categories.find((category) => category.label === selectedLabel) ??
      categories[0]
    );
  }, [categories, selectedLabel]);

  useEffect(() => {
    if (
      selectedLabel &&
      !categories.some((category) => category.label === selectedLabel)
    ) {
      setSelectedLabel(null);
    }
  }, [categories, selectedLabel]);

  const handleClick = (prompt: string) => {
    onSuggestionClick(prompt);
  };

  if (!selectedCategory) return null;

  return (
    <section className="chat-home-overview__section chat-home-overview__section--ideas">
      <h3 className="chat-home-overview__heading">Ideas</h3>
      <div className="chat-home-overview__idea-tabs" role="tablist">
        {categories.map((category) => {
          const selected = category.label === selectedCategory.label;
          return (
            <button
              key={category.label}
              type="button"
              role="tab"
              aria-selected={selected}
              className="chat-home-overview__idea-tab"
              onClick={() => setSelectedLabel(category.label)}
            >
              {category.label}
            </button>
          );
        })}
      </div>
      <ul className="chat-home-overview__ideas chat-home-overview__section-body">
        {selectedCategory.options.map((option) => (
          <li key={option.label}>
            <button
              type="button"
              className="chat-home-overview__idea"
              onClick={() => handleClick(option.prompt)}
            >
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

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

export function ChatHomeOverview() {
  const chat = useChatRuntime();
  const liveTasks = chat.conversation.streaming.liveTasks ?? [];
  const events = chat.conversation.events;
  const summariesByAgent = chat.conversation.streaming.taskProgressSummaries;

  // Build a full task history (running + completed/failed/canceled) by
  // replaying conversation events and merging with the live snapshot —
  // mirroring the footer-tasks merge so the chat home overview reflects
  // the same set the runtime knows about, not just what's in flight.
  const tasks = useMemo(() => {
    const persisted = extractTasksFromEvents(events);
    const merged = mergeFooterTasks(persisted, liveTasks);
    // Pin running tasks to the top, then most recent activity first.
    return [...merged].sort((a, b) => {
      const aRunning = a.status === "running";
      const bRunning = b.status === "running";
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      const aTime = a.completedAtMs ?? a.lastUpdatedAtMs ?? a.startedAtMs;
      const bTime = b.completedAtMs ?? b.lastUpdatedAtMs ?? b.startedAtMs;
      return bTime - aTime;
    });
  }, [events, liveTasks]);

  const files = useMemo<FileEntry[]>(() => {
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
        const filePayload = fileArtifactPayloadForPath(path, event.timestamp);
        if (!filePayload) continue;
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
      .slice(0, MAX_FILES);
  }, [events]);

  const handleOpenFile = (entry: FileEntry) => {
    displayTabs.openTab(payloadToTabSpec(entry.payload));
  };

  return (
    <div className="chat-home-overview">
      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Activity</h3>
        <div className="chat-home-overview__section-body">
        {tasks.length === 0 ? (
          <p className="chat-home-overview__empty">Nothing in flight.</p>
        ) : (
          <ul className="chat-home-overview__tasks">
            {tasks.map((task) => {
              const summaries = summariesByAgent.get(task.id) ?? [];
              return (
                <li
                  key={task.id}
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
                  {summaries.length > 0 && (
                    <TaskProgressFeed
                      summaries={summaries}
                      isRunning={task.status === "running"}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        </div>
      </section>

      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Recent files</h3>
        <div className="chat-home-overview__section-body">
        {files.length === 0 ? (
          <p className="chat-home-overview__empty">
            Files Stella changes will show up here.
          </p>
        ) : (
          <ul className="chat-home-overview__files">
            {files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="chat-home-overview__file"
                  onClick={() => handleOpenFile(entry)}
                  title={entry.path}
                >
                  <DisplayTabIcon
                    kind={payloadToTabSpec(entry.payload).kind}
                    size={18}
                  />
                  <span className="chat-home-overview__file-name">
                    {basenameOf(entry.path)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        </div>
      </section>

      <IdeasHomeSection />
    </div>
  );
}
