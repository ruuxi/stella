import { promises as fs } from "node:fs";

import { resolveFilePath } from "./file.js";
import type { ToolContext, ToolResult } from "./types.js";
import {
  imageMimeTypeFromPath,
  resolveImageMimeType,
} from "../shared/image-mime.js";
import { readImageFileSettled } from "../shared/read-image-file.js";

export const handleViewImage = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { error: "path is required." };
  }

  const detail =
    typeof args.detail === "string" && args.detail.trim().length > 0
      ? args.detail.trim()
      : null;
  if (detail && detail !== "original") {
    return {
      error:
        "view_image.detail only supports `original`; omit `detail` for the default behavior.",
    };
  }

  const filePath = resolveFilePath(rawPath, context);
  if (!imageMimeTypeFromPath(filePath)) {
    return {
      error:
        "view_image only supports local PNG, JPG, JPEG, GIF, and WEBP files.",
    };
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { error: `view_image path is not a file: ${filePath}` };
    }
  } catch {
    return { error: `Image not found: ${filePath}` };
  }

  // Settle the read against the capture -> read race: `view_image` is often
  // called on a screenshot the agent just captured, whose bytes may still be
  // flushing to disk. Reading early yields a truncated file; wait for it to
  // complete before handing the path onward as a vision input.
  const bytes = await readImageFileSettled(filePath);
  const mimeType = resolveImageMimeType(filePath, bytes);
  if (!mimeType) {
    return { error: `Unsupported image data: ${filePath}` };
  }

  const marker = `[stella-attach-image] inline=${mimeType} ${filePath}`;
  return {
    result: marker,
    details: {
      path: filePath,
      mimeType,
      detail,
    },
  };
};
