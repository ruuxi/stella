import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
import type { DisplayTabKind } from "./types";
import { kindForPath } from "./path-to-viewer";

/**
 * Pure mapping from a `DisplayPayload` to the `DisplayTabKind` used by
 * workspace icons and list rows. Keep this side-effect free so app/chat
 * surfaces can classify payloads without importing shell tab renderers.
 */
export const displayTabKindForPayload = (
  payload: DisplayTabPayload,
): DisplayTabKind => {
  switch (payload.kind) {
    case "canvas-html":
      return "canvas";
    case "url":
      return "url";
    case "markdown":
      return "markdown";
    case "source-diff":
      return "source-diff";
    case "office": {
      const inferred = kindForPath(payload.previewRef.sourcePath);
      return inferred === "office-spreadsheet" || inferred === "office-slides"
        ? inferred
        : "office-document";
    }
    case "file-artifact":
      return payload.artifactKind === "delimited-table"
        ? "office-spreadsheet"
        : payload.artifactKind;
    case "pdf":
      return "pdf";
    case "trash":
      return "trash";
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return "image";
        case "video":
          return "video";
        case "audio":
          return "audio";
        case "model3d":
          return "model3d";
        case "download":
          return "download";
        case "text":
          return "text";
      }
  }
};
