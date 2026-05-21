import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Download, Trash2 } from "lucide-react";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import { useConfirmAction } from "@/shared/hooks/use-confirm-action";
import { copyImageBlob } from "@/shell/media-clipboard";
import type { MediaTabItem } from "./media-actions";

const filePathsForItem = (item: MediaTabItem): string[] => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths.slice(0, 1);
    case "video":
    case "audio":
    case "model3d":
    case "download":
      return [item.asset.filePath];
    case "text":
      return [];
  }
};

export const MediaActionBar = ({
  item,
  onDelete,
}: {
  item: MediaTabItem;
  onDelete: () => void;
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const filePath = useMemo(() => filePathsForItem(item)[0] ?? null, [item]);
  const { files } = useDisplayFileBlobs(filePath ? [filePath] : []);
  const blob = files[0] ?? null;

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    const result = await window.electronAPI?.system?.saveFileAs?.(
      filePath,
      filePath.split(/[\\/]/).pop() ?? filePath,
    );
    if (!result || result.canceled) return;
    setMessage(result.ok ? "Saved" : (result.error ?? "Could not save"));
  }, [filePath]);

  const handleCopy = useCallback(async () => {
    try {
      if (item.asset.kind === "image" && blob) {
        await copyImageBlob(blob.blob);
      } else if (item.asset.kind === "text") {
        await navigator.clipboard.writeText(item.asset.text);
      } else if (filePath) {
        await navigator.clipboard.writeText(filePath);
      } else {
        return;
      }
      setMessage("Copied");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not copy");
    }
  }, [blob, filePath, item]);

  const canSave = Boolean(filePath && window.electronAPI?.system?.saveFileAs);

  const {
    armed: confirmDelete,
    trigger: handleDelete,
    reset: resetConfirmDelete,
  } = useConfirmAction(onDelete, { armedMs: 3000 });

  useEffect(() => resetConfirmDelete(), [item.id, resetConfirmDelete]);

  return (
    <Fragment>
      {canSave ? (
        <button
          type="button"
          className="media-tab__action-btn"
          onClick={handleSave}
          aria-label="Save"
          title="Save"
        >
          <Download size={14} strokeWidth={1.85} />
        </button>
      ) : null}
      <button
        type="button"
        className="media-tab__action-btn"
        onClick={handleCopy}
        aria-label="Copy"
        title="Copy"
      >
        <Copy size={14} strokeWidth={1.85} />
      </button>
      <button
        type="button"
        className={`media-tab__action-btn${
          confirmDelete ? " media-tab__action-btn--danger" : ""
        }`}
        onClick={handleDelete}
        aria-label={confirmDelete ? "Click again to delete" : "Delete"}
        title={confirmDelete ? "Click again to delete" : "Delete"}
      >
        <Trash2 size={14} strokeWidth={1.85} />
      </button>
      {message ? (
        <span className="media-tab__action-status">{message}</span>
      ) : null}
    </Fragment>
  );
};
