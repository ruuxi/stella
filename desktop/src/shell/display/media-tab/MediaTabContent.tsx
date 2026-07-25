import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronUp, Folder } from "@/ui/icons";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { removeGeneratedMediaItem } from "../payload-to-tab-spec";
import type { MediaTabItem } from "./media-item";
import {
  SUPPORTED_MEDIA_ACCEPT,
  dataTransferHasSupportedMedia,
  importLocalMedia,
  isSupportedMediaFile,
} from "@/features/workspace-display/media-files";
import { notifyMediaGenerationError } from "@/global/billing/paid-media-tier-toast";
import { MediaTile } from "./MediaTile";
import { MediaActionBar } from "./MediaActionBar";
import { HeroPrompt } from "./HeroPrompt";
import "../media-tab.css";

const RAIL_VISIBLE = 4;
const TRAY_INITIAL = 14;
const TRAY_PAGE = 24;

export const MediaTabContent = ({
  items: incomingItems,
  selectedItemId,
}: {
  items: ReadonlyArray<MediaTabItem>;
  selectedItemId?: string;
}) => {
  const [localItems, setLocalItems] = useState<{ source: ReadonlyArray<MediaTabItem>; value: ReadonlyArray<MediaTabItem> }>(() => ({ source: incomingItems, value: incomingItems }));
  const items = localItems.source === incomingItems ? localItems.value : incomingItems;
  const railItems = useMemo(() => [...items].reverse(), [items]);

  const [selection, setSelection] = useState(() => ({ sourceId: selectedItemId, selectedId: selectedItemId ?? items.at(-1)?.id ?? null }));
  const setSelectedId = useCallback((value: string | null | ((current: string | null) => string | null)) => {
    setSelection((current) => {
      const currentId = current.sourceId === selectedItemId ? current.selectedId : selectedItemId ?? null;
      return { sourceId: selectedItemId, selectedId: typeof value === "function" ? value(currentId) : value };
    });
  }, [selectedItemId]);
  const [draggingMedia, setDraggingMedia] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [trayVisible, setTrayVisible] = useState(TRAY_INITIAL);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  const requestedSelectedId = selection.sourceId === selectedItemId ? selection.selectedId : selectedItemId ?? null;
  const effectiveSelectedId = requestedSelectedId && items.some((item) => item.id === requestedSelectedId) ? requestedSelectedId : items.at(-1)?.id ?? null;

  const selectedItem =
    effectiveSelectedId != null
      ? items.find((item) => item.id === effectiveSelectedId) ?? null
      : null;

  const handleDeleteItem = useCallback((id: string) => {
    setLocalItems({ source: incomingItems, value: removeGeneratedMediaItem(id) });
    setSelectedId((current) => (current === id ? null : current));
  }, [incomingItems, setSelectedId]);

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

  const importDroppedFiles = useCallback(
    async (files: File[]) => {
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
    },
    [],
  );

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

  const expandPanel = useCallback(() => {
    displayTabs.setPanelExpanded(true);
  }, []);

  const visibleRailItems = useMemo(
    () => railItems.slice(0, RAIL_VISIBLE),
    [railItems],
  );
  const hasOverflowItems = railItems.length > RAIL_VISIBLE;
  const trayItems = useMemo(
    () => railItems.slice(0, trayVisible),
    [railItems, trayVisible],
  );

  const historyExpanded = expanded && hasOverflowItems;

  const handleToggleExpand = useCallback(() => {
    setExpanded((open) => {
      const next = !open;
      if (next) setTrayVisible(TRAY_INITIAL);
      return next;
    });
  }, []);

  const handleHistoryScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
        setTrayVisible((count) =>
          count < railItems.length ? count + TRAY_PAGE : count,
        );
      }
    },
    [railItems.length],
  );

  const handleSelectExpanded = useCallback((id: string) => {
    setSelectedId(id);
    setExpanded(false);
  }, [setSelectedId]);

  return (
    <div
      className="media-tab"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropOverlay visible={draggingMedia} variant="sidebar" />

      <div className="media-tab__surface">
        <div className="media-tab__hero">
          {selectedItem ? (
            <>
              <div
                className="media-tab__hero-bar"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="media-tab__hero-bar-top">
                  {selectedItem.capability ? (
                    <span className="media-tab__hero-cap">
                      {selectedItem.capability.replace(/_/g, " ")}
                    </span>
                  ) : null}
                  <div
                    className="media-tab__hero-actions"
                    role="group"
                    aria-label="Item actions"
                  >
                    <MediaActionBar
                      key={selectedItem.id}
                      item={selectedItem}
                      onDelete={() => handleDeleteItem(selectedItem.id)}
                    />
                  </div>
                </div>
                {selectedItem.prompt ? (
                  <HeroPrompt key={selectedItem.id} text={selectedItem.prompt} />
                ) : null}
              </div>
              <div className="media-tab__hero-preview">
                <MediaPreviewCard
                  asset={selectedItem.asset}
                  inDialog
                  {...(selectedItem.prompt ? { prompt: selectedItem.prompt } : {})}
                  {...(selectedItem.capability
                    ? { capability: selectedItem.capability }
                    : {})}
                />
              </div>
            </>
          ) : (
            <div className="media-tab__empty">
              <div className="media-tab__empty-title">No media yet</div>
              <div className="media-tab__empty-body">
                Drop an image, video, or sound file in, or add one from your
                computer below.
              </div>
            </div>
          )}
        </div>

        <div className="media-tab__footer">
          <div
            className={`media-tab__history${
              historyExpanded ? " media-tab__history--expanded" : ""
            }`}
          >
            {historyExpanded ? (
              <div
                className="media-tab__history-scroll"
                onScroll={handleHistoryScroll}
              >
                <div className="media-tab__history-grid">
                  <button
                    type="button"
                    className="media-tab__rail-import"
                    onClick={handlePickFile}
                    aria-label="Add a file from your computer"
                    title="Add a file from your computer"
                  >
                    <Folder size={18} strokeWidth={1.85} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={SUPPORTED_MEDIA_ACCEPT}
                    className="media-tab__file-input"
                    onChange={handleFileChange}
                  />
                  {trayItems.map((item) => (
                    <MediaTile
                      key={item.id}
                      item={item}
                      active={item.id === selectedItem?.id}
                      onSelect={() => handleSelectExpanded(item.id)}
                      onOpen={expandPanel}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="media-tab__rail" aria-label="Generated media">
                <button
                  type="button"
                  className="media-tab__rail-import"
                  onClick={handlePickFile}
                  aria-label="Add a file from your computer"
                  title="Add a file from your computer"
                >
                  <Folder size={18} strokeWidth={1.85} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={SUPPORTED_MEDIA_ACCEPT}
                  className="media-tab__file-input"
                  onChange={handleFileChange}
                />
                {visibleRailItems.map((item) => (
                  <MediaTile
                    key={item.id}
                    item={item}
                    active={item.id === selectedItem?.id}
                    onSelect={() => setSelectedId(item.id)}
                    onOpen={expandPanel}
                  />
                ))}
              </div>
            )}
            {hasOverflowItems ? (
              <button
                type="button"
                className={`media-tab__history-toggle${
                  historyExpanded ? " media-tab__history-toggle--open" : ""
                }`}
                onClick={handleToggleExpand}
                aria-expanded={historyExpanded}
                aria-label={historyExpanded ? "Hide all media" : "Show all media"}
                title={historyExpanded ? "Hide all media" : "Show all media"}
              >
                <ChevronUp size={16} strokeWidth={2.2} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
