import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronUp, Folder } from "lucide-react";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { updateComposerTextareaExpansion } from "@/shared/hooks/use-animated-composer-shell";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { displayTabs } from "../tab-store";
import {
  MEDIA_ACTIONS,
  type MediaActionId,
  type MediaAssetKind,
  type MediaTabItem,
} from "./media-actions";
import {
  SUPPORTED_MEDIA_ACCEPT,
  dataTransferHasSupportedMedia,
  importLocalMedia,
  isSupportedMediaFile,
  readSourceAsDataUri,
} from "./media-files";
import { notifyMediaGenerationError } from "@/shared/billing/paid-media-tier-toast";
import { useMediaGeneration } from "./use-media-generation";
import { MediaTile } from "./MediaTile";
import { AttachedChip } from "./AttachedChip";
import { MediaActionBar } from "./MediaActionBar";
import { HeroPrompt } from "./HeroPrompt";
import "../media-tab.css";

const RAIL_VISIBLE = 4;
const TRAY_PAGE = 24;

export const MediaTabContent = ({
  items: incomingItems,
  selectedItemId,
}: {
  items: ReadonlyArray<MediaTabItem>;
  selectedItemId?: string;
}) => {
  const items = incomingItems;
  const railItems = useMemo(() => [...items].reverse(), [items]);

  const [selectedId, setSelectedId] = useState<string | null>(
    selectedItemId ?? items.at(-1)?.id ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [actionId, setActionId] = useState<MediaActionId>("text_to_image");
  const [attachedItemId, setAttachedItemId] = useState<string | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [draggingMedia, setDraggingMedia] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayVisible, setTrayVisible] = useState(TRAY_PAGE);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragCounterRef = useRef(0);
  const { submitting, submit } = useMediaGeneration();

  useEffect(() => {
    if (selectedItemId && items.some((item) => item.id === selectedItemId)) {
      setSelectedId(selectedItemId);
    }
  }, [items, selectedItemId]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId == null || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items.at(-1)?.id ?? null);
    }
  }, [items, selectedId]);

  useEffect(() => {
    if (prompt === "") {
      setComposerExpanded(false);
      return;
    }
    requestAnimationFrame(() => {
      updateComposerTextareaExpansion(
        promptInputRef.current,
        setComposerExpanded,
      );
    });
  }, [prompt]);

  const selectedItem =
    selectedId != null
      ? items.find((item) => item.id === selectedId) ?? null
      : null;

  const handleClosePreview = useCallback(() => {
    setSelectedId(null);
    if (attachedItemId === selectedItem?.id) setAttachedItemId(null);
  }, [attachedItemId, selectedItem?.id]);

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

  const attachedItem = items.find((item) => item.id === attachedItemId) ?? null;
  const attachedKind: MediaAssetKind | null = attachedItem?.asset.kind ?? null;

  const visibleActions = useMemo(
    () =>
      MEDIA_ACTIONS.filter(
        (action) =>
          !action.sourceKind ||
          (attachedKind != null && action.sourceKind === attachedKind),
      ),
    [attachedKind],
  );
  const activeAction =
    visibleActions.find((action) => action.id === actionId) ??
    visibleActions[0] ??
    MEDIA_ACTIONS[0];
  useEffect(() => {
    if (!visibleActions.some((action) => action.id === actionId)) {
      setActionId(visibleActions[0]?.id ?? "text_to_image");
    }
  }, [actionId, visibleActions]);

  const compatibleAttachedItem =
    attachedItem &&
    activeAction.sourceKind &&
    attachedItem.asset.kind === activeAction.sourceKind
      ? attachedItem
      : null;
  const compatibleImagePath =
    compatibleAttachedItem?.asset.kind === "image"
      ? compatibleAttachedItem.asset.filePaths[0]
      : null;

  const needsImageSource = activeAction.sourceKind === "image";
  const canSubmit =
    prompt.trim().length > 0 &&
    !submitting &&
    (!needsImageSource || Boolean(compatibleImagePath));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      const source = compatibleImagePath
        ? await readSourceAsDataUri(compatibleImagePath)
        : null;
      await submit({
        capability: activeAction.id,
        prompt: prompt.trim(),
        ...(source ? { source } : {}),
      });
      setPrompt("");
      if (attachedItemId) setAttachedItemId(null);
    } catch {
      // submitMediaJob already toasted; nothing to do here.
    }
  };

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

  useEffect(() => {
    if (!hasOverflowItems && trayOpen) setTrayOpen(false);
  }, [hasOverflowItems, trayOpen]);

  const handleToggleTray = useCallback(() => {
    setTrayOpen((open) => {
      const next = !open;
      if (next) setTrayVisible(TRAY_PAGE);
      return next;
    });
  }, []);

  const handleTrayScroll = useCallback(
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

  const handleSelectFromTray = useCallback((id: string) => {
    setSelectedId(id);
    setTrayOpen(false);
  }, []);

  return (
    <div
      className="media-tab"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropOverlay visible={draggingMedia} variant="sidebar" />

      {trayOpen ? (
        <div
          className="media-tab__tray"
          role="region"
          aria-label="All generated media"
        >
          <div className="media-tab__tray-scroll" onScroll={handleTrayScroll}>
            <div className="media-tab__tray-grid">
              {trayItems.map((item) => (
                <MediaTile
                  key={item.id}
                  item={item}
                  active={item.id === selectedItem?.id}
                  onSelect={() => handleSelectFromTray(item.id)}
                  onAttach={() => setAttachedItemId(item.id)}
                  onOpen={expandPanel}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="media-tab__surface">
      <div className="media-tab__main">
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
                    item={selectedItem}
                    onClose={handleClosePreview}
                  />
                </div>
              </div>
              {selectedItem.prompt ? (
                <HeroPrompt text={selectedItem.prompt} />
              ) : null}
            </div>
            <div
              className="media-tab__hero-preview"
              onClick={expandPanel}
              role="button"
              title="Open"
            >
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
            <div className="media-tab__empty-title">Nothing made yet</div>
            <div className="media-tab__empty-body">
              Make a photo, video, or sound below, or drop a file in to edit
              it.
            </div>
          </div>
        )}
      </div>
      </div>

      <div className="media-tab__footer">
      {hasOverflowItems ? (
        <button
          type="button"
          className={`media-tab__rail-toggle${
            trayOpen ? " media-tab__rail-toggle--open" : ""
          }`}
          onClick={handleToggleTray}
          aria-expanded={trayOpen}
          aria-label={trayOpen ? "Hide all media" : "Show all media"}
          title={trayOpen ? "Hide all media" : "Show all media"}
        >
          <ChevronUp size={14} strokeWidth={2.2} />
        </button>
      ) : null}
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
            onAttach={() => setAttachedItemId(item.id)}
            onOpen={expandPanel}
          />
        ))}
      </div>

      <form
        className={`media-tab__composer${composerExpanded ? " expanded" : ""}`}
        onSubmit={onSubmit}
      >
        <div
          className="media-tab__modes"
          role="tablist"
          aria-label="Media modes"
        >
          {visibleActions.map((action) => {
            const attachedHere =
              attachedItem && attachedItem.asset.kind === action.sourceKind;
            const disabled = action.sourceKind === "image" && !attachedHere;
            return (
              <button
                key={action.id}
                type="button"
                role="tab"
                aria-selected={action.id === activeAction.id}
                className={`media-tab__mode${
                  action.id === activeAction.id ? " media-tab__mode--active" : ""
                }`}
                disabled={disabled}
                onClick={() => setActionId(action.id)}
              >
                {action.label}
              </button>
            );
          })}
        </div>
        <div className="media-tab__composer-row">
          {compatibleAttachedItem ? (
            <AttachedChip
              item={compatibleAttachedItem}
              onRemove={() => setAttachedItemId(null)}
            />
          ) : null}
          <textarea
            ref={promptInputRef}
            className="media-tab__prompt-input"
            value={prompt}
            rows={1}
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              requestAnimationFrame(() => {
                updateComposerTextareaExpansion(
                  promptInputRef.current,
                  setComposerExpanded,
                );
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={activeAction.placeholder}
            aria-label={activeAction.placeholder}
          />
          <button
            type="submit"
            className="media-tab__prompt-submit"
            disabled={!canSubmit}
            aria-label={submitting ? "Starting" : "Make"}
          >
            <ArrowUp size={14} strokeWidth={2.4} />
          </button>
        </div>
      </form>
      </div>
      </div>
    </div>
  );
};
