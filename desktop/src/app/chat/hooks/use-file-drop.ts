import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction, DragEvent } from "react";
import type { ChatContext } from "@/shared/types/electron";

/**
 * Image MIME types that get rendered as visual thumbnails (regionScreenshots).
 */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Max file size in bytes (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

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

      const allFiles = Array.from(e.dataTransfer?.files ?? []).filter(
        (f) => f.size <= MAX_FILE_SIZE,
      );
      if (allFiles.length === 0) return;

      const imageFiles = allFiles.filter((f) => IMAGE_TYPES.has(f.type));
      const otherFiles = allFiles.filter((f) => !IMAGE_TYPES.has(f.type));

      // Images → regionScreenshots (thumbnails)
      const imageResults = await Promise.allSettled(
        imageFiles.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          const { width, height } = await getImageDimensions(dataUrl);
          return { dataUrl, width, height };
        }),
      );
      const newScreenshots = imageResults
        .filter(
          (r): r is PromiseFulfilledResult<{ dataUrl: string; width: number; height: number }> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);

      // Other files → files (badges)
      const fileResults = await Promise.allSettled(
        otherFiles.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          return {
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            dataUrl,
          };
        }),
      );
      const newFiles = fileResults
        .filter(
          (r): r is PromiseFulfilledResult<{
            name: string; size: number; mimeType: string; dataUrl: string;
          }> => r.status === "fulfilled",
        )
        .map((r) => r.value);

      if (newScreenshots.length === 0 && newFiles.length === 0) return;

      setChatContext((prev) => {
        const base = prev ?? { window: null };
        return {
          ...base,
          ...(newScreenshots.length > 0 && {
            regionScreenshots: [...(base.regionScreenshots ?? []), ...newScreenshots],
          }),
          ...(newFiles.length > 0 && {
            files: [...(base.files ?? []), ...newFiles],
          }),
        };
      });
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
