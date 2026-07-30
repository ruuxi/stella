/**
 * Work — one recent, searchable index of agent threads and files.
 *
 * The persisted section id remains `files` so existing locations migrate
 * without churn. Its default view merges both sources by their latest update;
 * selecting either kind opens its viewer inside the resizable right sidebar.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  displaySearchStore,
  useDisplaySearchFocusRequest,
  useDisplaySearchOpen,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  forgetArtifactFileEntry,
  useFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import {
  dataTransferHasSupportedMedia,
  importLocalMedia,
  isSupportedMediaFile,
} from "@/features/workspace-display/media-files";
import {
  openAgentThreadTab,
  openDisplayPayloadTab,
} from "@/features/workspace-display/open-payload";
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import {
  useDisplayPanelOpen,
  useDisplayTabList,
} from "@/features/workspace-display/tab-store";
import { notifyMediaGenerationError } from "@/global/billing/paid-media-tier-toast";
import {
  loadCanvasHtmlHistory,
  removeCanvasHtmlItem,
} from "@/shell/display/canvas-tab/canvas-items";
import { removeGeneratedMediaItem } from "@/shell/display/payload-to-tab-spec";
import { ChevronLeft, Search, X } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./files-section.css";

type WorkItem =
  | { kind: "agent"; id: string; timestamp: number; task: TaskItem }
  | { kind: "file"; id: string; timestamp: number; entry: FileEntry };

const forgetEntry = (entry: FileEntry): void => {
  switch (entry.source) {
    case "canvas":
      if (entry.filePath) removeCanvasHtmlItem(entry.filePath);
      return;
    case "media":
      removeGeneratedMediaItem(entry.id);
      return;
    case "artifact":
      forgetArtifactFileEntry(entry.id);
  }
};

const workItemLabel = (item: WorkItem): string =>
  item.kind === "agent" ? item.task.description : item.entry.title;

const taskTimestamp = (task: TaskItem): number =>
  task.lastUpdatedAtMs || task.completedAtMs || task.startedAtMs;

function WorkList() {
  const chat = useChatRuntime();
  const { state } = useUiState();
  const entries = useFileEntries();
  const panelOpen = useDisplayPanelOpen();
  const activeSection = useActiveSidebarSection();
  const searchOpen = useDisplaySearchOpen();
  const storedQuery = useDisplaySearchQuery();
  const focusRequest = useDisplaySearchFocusRequest();
  const [inputValue, setInputValue] = useState(storedQuery);
  const deferredQuery = useDeferredValue(inputValue.trim().toLowerCase());
  const inputRef = useRef<HTMLInputElement>(null);
  const [draggingMedia, setDraggingMedia] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    void loadCanvasHtmlHistory();
  }, []);

  useEffect(() => {
    if (!searchOpen) {
      setInputValue("");
      return;
    }
    const timer = window.setTimeout(() => {
      displaySearchStore.setQuery(inputValue);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [inputValue, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, searchOpen]);

  useEffect(() => {
    if (searchOpen && (!panelOpen || activeSection !== "files")) {
      displaySearchStore.close();
    }
  }, [activeSection, panelOpen, searchOpen]);

  const items = useMemo(() => {
    const query = searchOpen ? deferredQuery : "";
    const agents: WorkItem[] = chat.conversation.tasks
      .filter((task) => {
        if (!query) return true;
        return `${task.description} ${task.agentType}`
          .toLowerCase()
          .includes(query);
      })
      .map((task) => ({
        kind: "agent",
        id: `agent:${task.id}`,
        timestamp: taskTimestamp(task),
        task,
      }));
    const files: WorkItem[] = entries
      .filter((entry) => {
        if (!query) return true;
        return `${entry.title} ${entry.filePath ?? ""}`
          .toLowerCase()
          .includes(query);
      })
      .map((entry) => ({
        kind: "file",
        id: `file:${entry.id}`,
        timestamp: entry.createdAt,
        entry,
      }));
    return [...agents, ...files].sort(
      (a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id),
    );
  }, [chat.conversation.tasks, deferredQuery, entries, searchOpen]);

  const importDroppedFiles = useCallback(async (files: File[]) => {
    const supported = files.filter(isSupportedMediaFile);
    if (supported.length === 0) {
      notifyMediaGenerationError(
        new Error("Drop an image, video, or audio file."),
      );
      return;
    }
    try {
      for (const file of supported) {
        await importLocalMedia(file);
      }
      if (supported.length < files.length) {
        notifyMediaGenerationError(
          new Error("Some files were skipped because they are not media."),
        );
      }
    } catch (error) {
      notifyMediaGenerationError(error);
    }
  }, []);

  return (
    <div
      className="files-list"
      data-search-open={searchOpen || undefined}
      onDragEnter={(event) => {
        if (!dataTransferHasSupportedMedia(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setDraggingMedia(true);
      }}
      onDragOver={(event) => {
        if (!dataTransferHasSupportedMedia(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!draggingMedia) return;
        event.preventDefault();
        event.stopPropagation();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setDraggingMedia(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dragCounterRef.current = 0;
        setDraggingMedia(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) void importDroppedFiles(files);
      }}
    >
      <DropOverlay visible={draggingMedia} variant="sidebar" />
      {searchOpen ? (
        <div className="files-list__search">
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            placeholder="Search agents and files"
            onChange={(event) => setInputValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") displaySearchStore.close();
            }}
            aria-label="Search agents and files"
          />
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="sidebar-section__empty">
          {deferredQuery
            ? "No agents or files match that search."
            : "Agent threads and files will show up here."}
        </div>
      ) : (
        <div className="sidebar-section__scroll">
          <ul className="files-list__items">
            {items.map((item) =>
              item.kind === "agent" ? (
                <li key={item.id} className="files-list__item">
                  <button
                    type="button"
                    className="files-list__open"
                    onClick={() =>
                      state.conversationId
                        ? openAgentThreadTab({
                            threadId: item.task.id,
                            conversationId: state.conversationId,
                            agentType: item.task.agentType,
                            title:
                              item.task.description.trim() ||
                              item.task.agentType ||
                              "Agent thread",
                          })
                        : undefined
                    }
                    title={workItemLabel(item)}
                  >
                    <span className="files-list__icon" aria-hidden="true">
                      <AgentLifecycleStatusIcon
                        status={item.task.status}
                        size={17}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span className="files-list__title">
                      {workItemLabel(item)}
                    </span>
                    <span className="files-list__meta">Agent</span>
                  </button>
                </li>
              ) : (
                <li key={item.id} className="files-list__item">
                  <button
                    type="button"
                    className="files-list__open"
                    onClick={() => openDisplayPayloadTab(item.entry.payload)}
                    title={item.entry.filePath ?? item.entry.title}
                  >
                    <span className="files-list__icon" aria-hidden="true">
                      <DisplayTabIcon kind={item.entry.kind} size={17} />
                    </span>
                    <span className="files-list__title">
                      {workItemLabel(item)}
                    </span>
                    <span className="files-list__meta">File</span>
                  </button>
                  <button
                    type="button"
                    className="files-list__remove"
                    onClick={() => forgetEntry(item.entry)}
                    aria-label={`Remove ${item.entry.title}`}
                    title={`Remove ${item.entry.title}`}
                  >
                    <X size={12} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export function FilesSection() {
  const openTabId = useSidebarSectionLocation("files");
  const { tabs } = useDisplayTabList();

  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) return <WorkList />;

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("files")}
          aria-label="Back to work"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Work
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
