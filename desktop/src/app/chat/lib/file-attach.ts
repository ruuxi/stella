/**
 * Shared composer file-attachment plumbing.
 *
 * Both `useFileDrop` (drag-and-drop) and the composer "+" menu's file
 * picker need the same routing rules: image MIME types render as
 * `regionScreenshots` thumbnails, everything else becomes a `files`
 * badge. The processing also gates on a 20 MB per-file cap.
 *
 * `recent files` reuses the already-processed shape so it can re-attach
 * without going back through the FileReader pipeline.
 */
import type { Dispatch, SetStateAction } from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";

export type AttachedScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
};

export type AttachedFile = ChatContextFile;

export type ProcessedAttachments = {
  screenshots: AttachedScreenshot[];
  files: AttachedFile[];
};

export const ATTACHMENT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Max raw file size (20 MB). Matches the historical drag-drop cap. */
export const ATTACHMENT_MAX_FILE_SIZE = 20 * 1024 * 1024;

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export function isAttachableImage(mimeType: string): boolean {
  return ATTACHMENT_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Process raw `File` objects into the chatContext-shaped attachment
 * payload. Files exceeding {@link ATTACHMENT_MAX_FILE_SIZE} are silently
 * dropped; per-file read failures are skipped without throwing.
 */
export async function processInputFiles(
  files: readonly File[],
): Promise<ProcessedAttachments> {
  const accepted = files.filter((f) => f.size <= ATTACHMENT_MAX_FILE_SIZE);
  if (accepted.length === 0) {
    return { screenshots: [], files: [] };
  }

  const imageFiles = accepted.filter((f) => isAttachableImage(f.type));
  const otherFiles = accepted.filter((f) => !isAttachableImage(f.type));

  const imageResults = await Promise.allSettled(
    imageFiles.map(async (file): Promise<AttachedScreenshot> => {
      const dataUrl = await readFileAsDataUrl(file);
      const { width, height } = await getImageDimensions(dataUrl);
      return { dataUrl, width, height };
    }),
  );

  const fileResults = await Promise.allSettled(
    otherFiles.map(async (file): Promise<AttachedFile> => {
      const dataUrl = await readFileAsDataUrl(file);
      return {
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        dataUrl,
      };
    }),
  );

  return {
    screenshots: imageResults
      .filter(
        (r): r is PromiseFulfilledResult<AttachedScreenshot> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
    files: fileResults
      .filter(
        (r): r is PromiseFulfilledResult<AttachedFile> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
  };
}

/**
 * Apply already-processed attachments to a `setChatContext` setter,
 * appending to any existing screenshots/files. Returns false when there
 * was nothing to apply so callers can short-circuit UI updates.
 */
export function applyProcessedAttachments(
  attachments: ProcessedAttachments,
  setChatContext: SetChatContext,
): boolean {
  const { screenshots, files } = attachments;
  if (screenshots.length === 0 && files.length === 0) return false;

  setChatContext((prev) => {
    const base = prev ?? { window: null };
    return {
      ...base,
      ...(screenshots.length > 0 && {
        regionScreenshots: [
          ...(base.regionScreenshots ?? []),
          ...screenshots,
        ],
      }),
      ...(files.length > 0 && {
        files: [...(base.files ?? []), ...files],
      }),
    };
  });
  return true;
}

/**
 * Convenience: process a `File[]` and apply the result in one call.
 * Returns the processed payload so callers (e.g. the "+" menu's recent
 * files cache) can persist a copy of what was just attached.
 */
export async function attachFilesToContext(
  files: readonly File[],
  setChatContext: SetChatContext,
): Promise<ProcessedAttachments> {
  const processed = await processInputFiles(files);
  applyProcessedAttachments(processed, setChatContext);
  return processed;
}
