import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Folder } from "lucide-react";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { displayTabs } from "../tab-store";
import { removeGeneratedMediaItem } from "../payload-to-tab-spec";
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
import { useMediaGeneration } from "./use-media-generation";
import { MediaTile } from "./MediaTile";
import { AttachedChip } from "./AttachedChip";
import { MediaActionBar } from "./MediaActionBar";
import { MediaIllustration } from "../illustrations/MediaIllustration";
import "../media-tab.css";

export const MediaTabContent = ({
  items: incomingItems,
}: {
  items: ReadonlyArray<MediaTabItem>;
}) => {
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const items = useMemo(
    () => incomingItems.filter((item) => !removedIds.has(item.id)),
    [incomingItems, removedIds],
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    items.at(-1)?.id ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [actionId, setActionId] = useState<MediaActionId>("text_to_image");
  const [attachedItemId, setAttachedItemId] = useState<string | null>(null);
  const [draggingMedia, setDraggingMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const { submitting, error, setError, submit } = useMediaGeneration();

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items.at(-1)?.id ?? null);
    }
  }, [items, selectedId]);

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items.at(-1) ?? null;

  const handleDelete = useCallback(
    (id: string) => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      removeGeneratedMediaItem(id);
      if (attachedItemId === id) setAttachedItemId(null);
    },
    [attachedItemId],
  );

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
        setError(err instanceof Error ? err.message : "Could not import file");
      }
    },
    [setError],
  );

  const importDroppedFiles = useCallback(
    async (files: File[]) => {
      const supported = files.filter(isSupportedMediaFile);
      if (supported.length === 0) {
        setError("Drop an image, video, or audio file.");
        return;
      }
      setError(null);
      try {
        for (const file of supported) {
          await importLocalMedia(file);
        }
        if (supported.length < files.length) {
          setError("Some files were skipped because they are not media.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not import files");
      }
    },
    [setError],
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
      // submit() already wrote `error` for us; nothing to do here.
    }
  };

  const expandPanel = useCallback(() => {
    displayTabs.setPanelExpanded(true);
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
      <div className="media-tab__top">
        {selectedItem ? (
          <MediaActionBar
            item={selectedItem}
            onDelete={() => handleDelete(selectedItem.id)}
          />
        ) : null}
      </div>

      <div
        className="media-tab__hero"
        onClick={selectedItem ? expandPanel : undefined}
        role={selectedItem ? "button" : undefined}
        title={selectedItem ? "Expand panel" : undefined}
      >
        {selectedItem ? (
          <MediaPreviewCard
            asset={selectedItem.asset}
            inDialog
            {...(selectedItem.prompt ? { prompt: selectedItem.prompt } : {})}
            {...(selectedItem.capability
              ? { capability: selectedItem.capability }
              : {})}
          />
        ) : (
          <div className="media-tab__hero-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", padding: 24 }}>
            <div style={{ width: 180, height: 135, opacity: 0.9 }}>
              <MediaIllustration />
            </div>
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-strong)" }}>
              No media yet
            </div>
            <div style={{ fontSize: 15, color: "var(--text-weak)", maxWidth: 260, lineHeight: 1.45 }}>
              Generate an image, video, or audio from the composer below — or
              drop a file in to edit it.
            </div>
          </div>
        )}
      </div>

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
        {items.map((item) => (
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

      {error ? <div className="media-tab__error">{error}</div> : null}

      <form className="media-tab__composer" onSubmit={onSubmit}>
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
                className={
                  action.id === activeAction.id
                    ? "media-tab__mode media-tab__mode--active"
                    : "media-tab__mode"
                }
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
          <input
            type="text"
            className="media-tab__prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={activeAction.placeholder}
            aria-label={activeAction.placeholder}
          />
          <button
            type="submit"
            className="media-tab__prompt-submit"
            disabled={!canSubmit}
            aria-label={submitting ? "Starting" : "Make"}
          >
            <ArrowRight size={16} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
};
