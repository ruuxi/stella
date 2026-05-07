import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Trash2 } from "lucide-react";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import { copyImageBlob } from "@/shell/media-clipboard";
import type { MediaTabItem } from "./media-actions";

export const MediaActionBar = ({
  item,
  onDelete,
}: {
  item: MediaTabItem;
  onDelete: () => void;
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const filePaths = useMemo(() => {
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
  }, [item]);
  const { files } = useDisplayFileBlobs(filePaths);
  const blob = files[0] ?? null;
  const filePath = filePaths[0] ?? null;

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
        setMessage("Copied");
        return;
      }
      if (item.asset.kind === "text") {
        await navigator.clipboard.writeText(item.asset.text);
        setMessage("Copied");
        return;
      }
      if (filePath) {
        await navigator.clipboard.writeText(filePath);
        setMessage("Copied");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not copy");
    }
  }, [blob, filePath, item]);

  const canSave = Boolean(filePath && window.electronAPI?.system?.saveFileAs);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    setConfirmDelete(false);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [item.id]);

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmDelete(false);
      }, 3000);
      return;
    }
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmDelete(false);
    onDelete();
  }, [confirmDelete, onDelete]);

  return (
    <div className="media-tab__actions" aria-label="Item actions">
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
        className={
          confirmDelete
            ? "media-tab__action-btn media-tab__action-btn--danger"
            : "media-tab__action-btn"
        }
        onClick={handleDelete}
        aria-label={confirmDelete ? "Click again to delete" : "Delete"}
        title={confirmDelete ? "Click again to delete" : "Delete"}
      >
        <Trash2 size={14} strokeWidth={1.85} />
      </button>
      {message ? (
        <span className="media-tab__action-status">{message}</span>
      ) : null}
    </div>
  );
};
