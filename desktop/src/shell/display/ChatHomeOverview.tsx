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
import { useMemo } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
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
import type { TaskItem } from "@/app/chat/lib/event-transforms";
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

const taskBadgeFor = (task: TaskItem): string => {
  switch (task.status) {
    case "running":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    default:
      return "";
  }
};

export function ChatHomeOverview() {
  const chat = useChatRuntime();
  const tasks = chat.conversation.streaming.liveTasks;
  const events = chat.conversation.events;

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
        {tasks.length === 0 ? (
          <p className="chat-home-overview__empty">Nothing in flight.</p>
        ) : (
          <ul className="chat-home-overview__tasks">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="chat-home-overview__task"
                data-status={task.status}
              >
                <span className="chat-home-overview__task-text">
                  {taskLineFor(task)}
                </span>
                <span className="chat-home-overview__task-status">
                  {taskBadgeFor(task)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="chat-home-overview__section">
        <h3 className="chat-home-overview__heading">Recent files</h3>
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
      </section>
    </div>
  );
}
