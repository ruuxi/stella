import { promises as fs } from "node:fs";

import { resolveFilePath } from "./file.js";
import type { ToolContext, ToolResult } from "./types.js";
import {
  imageMimeTypeFromPath,
  resolveImageMimeType,
} from "../shared/image-mime.js";

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

  const bytes = await fs.readFile(filePath);
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
