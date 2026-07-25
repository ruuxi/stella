/**
 * Files — the merged Canvas + Media surface.
 *
 * One tab for everything Stella can show you: HTML canvases, images, audio,
 * video, PDFs, markdown, office documents, diffs. Its default view is a list;
 * opening an entry renders it in place.
 *
 * Sub-location (`sidebarSections` → `locations.files`) is the display-tab id of
 * the open artifact, or `null` for the list. Artifact payloads arriving from an
 * agent register a viewer in `displayTabs` and point this section at it, so the
 * workspace-display payload system keeps working unchanged — it just targets
 * Files now instead of separate Canvas and Media tabs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  forgetArtifactFileEntry,
  useFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import {
  SUPPORTED_MEDIA_ACCEPT,
  dataTransferHasSupportedMedia,
  importLocalMedia,
  isSupportedMediaFile,
} from "@/features/workspace-display/media-files";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import {
  sidebarSections,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import { notifyMediaGenerationError } from "@/global/billing/paid-media-tier-toast";
import {
  loadCanvasHtmlHistory,
  removeCanvasHtmlItem,
} from "@/shell/display/canvas-tab/canvas-items";
import { removeGeneratedMediaItem } from "@/shell/display/payload-to-tab-spec";
import { ChevronLeft, Plus, X } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./files-section.css";

/**
 * Route a removal back to the store that owns the artifact. Canvas and media
 * keep their own tombstones; everything else is only ever known to the index.
 */
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

function FilesList() {
  const entries = useFileEntries();
  const [draggingMedia, setDraggingMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  // Canvases written by an earlier run are on disk but not in the persisted
  // index until they're enumerated, so the list asks for them once.
  useEffect(() => {
    void loadCanvasHtmlHistory();
  }, []);

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        await importLocalMedia(file);
      } catch (err) {
        notifyMediaGenerationError(err);
      }
    },
    [],
  );

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
    } catch (err) {
      notifyMediaGenerationError(err);
    }
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasSupportedMedia(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setDraggingMedia(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasSupportedMedia(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingMedia) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setDraggingMedia(false);
      }
    },
    [draggingMedia],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setDraggingMedia(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void importDroppedFiles(files);
    },
    [importDroppedFiles],
  );

  return (
    <div
      className="files-list"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropOverlay visible={draggingMedia} variant="sidebar" />

      <div className="files-list__head">
        <button
          type="button"
          className="files-list__import"
          onClick={handlePickFile}
          title="Add a file from your computer"
        >
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
          Add a file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_MEDIA_ACCEPT}
          className="files-list__file-input"
          onChange={handleFileChange}
        />
      </div>

      {entries.length === 0 ? (
        <div className="sidebar-section__empty">
          Files Stella creates or opens will show up here.
        </div>
      ) : (
        <div className="sidebar-section__scroll">
          <ul className="files-list__items">
            {entries.map((entry) => (
              <li key={entry.id} className="files-list__item">
                <button
                  type="button"
                  className="files-list__open"
                  onClick={() => openDisplayPayloadTab(entry.payload)}
                  title={entry.filePath ?? entry.title}
                >
                  <span className="files-list__icon" aria-hidden="true">
                    <DisplayTabIcon kind={entry.kind} size={18} />
                  </span>
                  <span className="files-list__title">{entry.title}</span>
                </button>
                <button
                  type="button"
                  className="files-list__remove"
                  onClick={() => forgetEntry(entry)}
                  aria-label={`Remove ${entry.title}`}
                  title={`Remove ${entry.title}`}
                >
                  <X size={12} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function FilesSection() {
  const openTabId = useSidebarSectionLocation("files");
  const { tabs } = useDisplayTabList();

  // A remembered id can outlive its tab (the registry is not persisted across
  // launches). Falling back to the list is the graceful degradation.
  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) return <FilesList />;

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("files")}
          aria-label="Back to files"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Files
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
