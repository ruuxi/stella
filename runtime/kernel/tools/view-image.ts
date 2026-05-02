import { promises as fs } from "node:fs";

import { resolveFilePath } from "./file.js";
import type { ToolContext, ToolResult } from "./types.js";

const imageMimeForPath = (filePath: string): string | null => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
};

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
  const mimeType = imageMimeForPath(filePath);
  if (!mimeType) {
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
