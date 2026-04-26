import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction, DragEvent } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { attachFilesToContext } from "@/app/chat/lib/file-attach";

type UseFileDropOptions = {
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  /** Disable drop zone (e.g. while streaming). */
  disabled?: boolean;
};

type UseFileDropReturn = {
  /** Whether files are currently being dragged over the drop zone. */
  isDragOver: boolean;
  /** Whether any file drag is happening anywhere on the window. */
  isWindowDragActive: boolean;
  /** Bind these to the drop-zone element. */
  dropHandlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
};

function hasFiles(e: DragEvent): boolean {
  const items = e.dataTransfer?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "file") return true;
  }
  return false;
}

/**
 * Shared drag-and-drop hook for all composers.
 *
 * Dropped image files → `chatContext.regionScreenshots` (thumbnails).
 * Other files → `chatContext.files` (file badges).
 */
export function useFileDrop({
  setChatContext,
  disabled = false,
}: UseFileDropOptions): UseFileDropReturn {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isWindowDragActive, setIsWindowDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const windowDragCounterRef = useRef(0);

  // Window-level drag detection — for components with pointer-events:none
  useEffect(() => {
    if (disabled) return;
    const onEnter = () => {
      windowDragCounterRef.current += 1;
      if (windowDragCounterRef.current === 1) setIsWindowDragActive(true);
    };
    const onLeave = () => {
      windowDragCounterRef.current -= 1;
      if (windowDragCounterRef.current <= 0) {
        windowDragCounterRef.current = 0;
        setIsWindowDragActive(false);
      }
    };
    const onDrop = () => {
      windowDragCounterRef.current = 0;
      setIsWindowDragActive(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      windowDragCounterRef.current = 0;
      setIsWindowDragActive(false);
    };
  }, [disabled]);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled || !hasFiles(e)) return;
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (disabled) return;

      const allFiles = Array.from(e.dataTransfer?.files ?? []);
      if (allFiles.length === 0) return;
      await attachFilesToContext(allFiles, setChatContext);
    },
    [disabled, setChatContext],
  );

  return {
    isDragOver,
    isWindowDragActive,
    dropHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
