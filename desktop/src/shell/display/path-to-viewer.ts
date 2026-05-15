/**
 * Pure functions that map file paths and tool-call shapes to
 * `DisplayTabKind` / id / title — the equivalent of Codex's `Ds(path)` /
 * `Ms(path)` mappers in `use-model-settings-ldiRRtPt.js`.
 *
 * Kept render-free and dependency-free so the chat surface, IPC bridge, and
 * tests can all share the same routing rules.
 */

import type { DisplayTabKind } from "./types";
import type {
  DisplayFileArtifactKind,
  DisplayPayload,
} from "@/shared/contracts/display-payload";
import { DEVELOPER_EXTS } from "@/shared/contracts/external-openers";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "gif",
  "bmp",
  "svg",
  "ico",
  "tif",
  "tiff",
]);

const PDF_EXTS = new Set(["pdf"]);

const OFFICE_DOC_EXTS = new Set(["doc", "docx"]);
const OFFICE_SHEET_EXTS = new Set(["xls", "xlsx", "xlsm", "csv", "tsv"]);
const OFFICE_PREVIEW_SHEET_EXTS = new Set(["xlsx", "xlsm"]);
const OFFICE_SLIDES_EXTS = new Set(["ppt", "pptx"]);
const DELIMITED_TABLE_EXTS = new Set(["csv", "tsv"]);

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const MODEL3D_EXTS = new Set(["glb", "gltf", "obj", "stl"]);
const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const DEVELOPER_RESOURCE_EXTS = new Set(DEVELOPER_EXTS);

/**
 * Extensions whose mere appearance in a turn's edited-paths list should
 * surface a clickable end-of-turn resource pill in the chat. Mirrors
 * Codex's `_de` set but adds the media types Stella also previews.
 */
const PREFERRED_RESOURCE_EXTS = new Set<string>([
  ...OFFICE_DOC_EXTS,
  ...OFFICE_SHEET_EXTS,
  ...OFFICE_SLIDES_EXTS,
  ...PDF_EXTS,
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
  ...MODEL3D_EXTS,
]);

/**
 * Broader set: only used as a fallback when the turn touched exactly one
 * unique path. Mirrors Codex's `gde`. Adds markdown-ish + plain-text source
 * files we want the user to be able to peek at.
 */
const FALLBACK_RESOURCE_EXTS = new Set<string>([
  ...PREFERRED_RESOURCE_EXTS,
  ...MARKDOWN_EXTS,
  "txt",
]);

/** Lowercased extension (without dot) or `null` for paths without one. */
export const extensionOf = (filePath: string): string | null => {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return null;
  // Strip query / hash that sometimes ride along with image URLs.
  const cleaned = trimmed.split(/[?#]/)[0] ?? trimmed;
  const lastSlash = Math.max(
    cleaned.lastIndexOf("/"),
    cleaned.lastIndexOf("\\"),
  );
  const tail = lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot === tail.length - 1) return null;
  return tail.slice(dot + 1).toLowerCase();
};

export const basenameOf = (filePath: string): string => {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return filePath;
  const cleaned = trimmed.split(/[?#]/)[0] ?? trimmed;
  const lastSlash = Math.max(
    cleaned.lastIndexOf("/"),
    cleaned.lastIndexOf("\\"),
  );
  return lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
};

/**
 * Map an extension to a `DisplayTabKind`. Returns `null` for unknown types
 * so callers can skip rendering a card.
 */
export const kindForExtension = (
  extension: string | null,
): DisplayTabKind | null => {
  if (extension == null) return null;
  if (IMAGE_EXTS.has(extension)) return "image";
  if (PDF_EXTS.has(extension)) return "pdf";
  if (OFFICE_DOC_EXTS.has(extension)) return "office-document";
  if (OFFICE_SHEET_EXTS.has(extension)) return "office-spreadsheet";
  if (OFFICE_SLIDES_EXTS.has(extension)) return "office-slides";
  if (MARKDOWN_EXTS.has(extension)) return "markdown";
  if (VIDEO_EXTS.has(extension)) return "video";
  if (AUDIO_EXTS.has(extension)) return "audio";
  if (MODEL3D_EXTS.has(extension)) return "model3d";
  return null;
};

export const kindForPath = (filePath: string): DisplayTabKind | null =>
  kindForExtension(extensionOf(filePath));

const fileArtifactKindForPath = (
  filePath: string,
): DisplayFileArtifactKind | null => {
  const extension = extensionOf(filePath);
  if (extension == null) return null;
  if (OFFICE_DOC_EXTS.has(extension)) return "office-document";
  if (DELIMITED_TABLE_EXTS.has(extension)) return "delimited-table";
  if (OFFICE_PREVIEW_SHEET_EXTS.has(extension)) return "office-spreadsheet";
  if (OFFICE_SLIDES_EXTS.has(extension)) return "office-slides";
  return null;
};

export const fileArtifactPayloadForPath = (
  filePath: string,
  createdAt?: number,
): DisplayPayload | null => {
  const artifactKind = fileArtifactKindForPath(filePath);
  return artifactKind
    ? {
        kind: "file-artifact",
        filePath,
        artifactKind,
        title: basenameOf(filePath),
        ...(createdAt !== undefined ? { createdAt } : {}),
      }
    : null;
};

const isMarkdownExtension = (extension: string | null): boolean =>
  extension != null && MARKDOWN_EXTS.has(extension);

export const isDeveloperResourceExtension = (
  extension: string | null,
): boolean => extension != null && DEVELOPER_RESOURCE_EXTS.has(extension);

/**
 * Codex-style primary-path picker for a turn.
 *
 * Returns the single most-relevant edited / generated file path for a
 * completed turn, or `null` if there isn't one worth surfacing as a card.
 *
 * Rules (mirrors `vde` + `_de`/`gde` in Codex's bundle):
 *   1. Dedupe by absolute path; keep the first display form.
 *   2. If any path's extension is in `PREFERRED_RESOURCE_EXTS` (Office/PDF/
 *      media/3D), return the **first** such — this prioritizes a single
 *      "interesting" artifact when the turn touched many files.
 *   3. Otherwise, return the first markdown file; markdown is readable enough
 *      to surface even alongside developer-only paths.
 *   4. Otherwise, if the turn touched exactly one unique path **and** its
 *      extension is in the broader `FALLBACK_RESOURCE_EXTS` set, return that.
 *   5. Otherwise return `null`.
 */
export const pickPrimaryEditedPath = (
  candidatePaths: string[],
  options?: { includeDeveloperResources?: boolean },
): string | null => {
  if (candidatePaths.length === 0) return null;

  const seen = new Map<string, string>();
  for (const raw of candidatePaths) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    if (!seen.has(cleaned)) {
      seen.set(cleaned, cleaned);
    }
  }

  const unique = [...seen.values()];
  if (unique.length === 0) return null;

  const preferred = unique.find((p) => {
    const ext = extensionOf(p);
    return ext != null && PREFERRED_RESOURCE_EXTS.has(ext);
  });
  if (preferred) return preferred;

  const markdown = unique.find((p) => isMarkdownExtension(extensionOf(p)));
  if (markdown) return markdown;

  if (unique.length === 1) {
    const only = unique[0]!;
    const ext = extensionOf(only);
    if (ext != null && FALLBACK_RESOURCE_EXTS.has(ext)) {
      return only;
    }
    if (
      options?.includeDeveloperResources === true &&
      isDeveloperResourceExtension(ext)
    ) {
      return only;
    }
  }

  return null;
};

/**
 * Stable tab id for a path-anchored viewer. Ids are stable across
 * re-opens, so clicking the same resource pill twice doesn't stack tabs.
 */
export const tabIdForPath = (filePath: string): string => {
  const kind = kindForPath(filePath);
  if (kind === "pdf") return `pdf:${filePath}`;
  if (kind === "markdown") return `markdown:${filePath}`;
  if (isDeveloperResourceExtension(extensionOf(filePath))) {
    // Developer file changes all share the singleton "Code changes"
    // tab (`SOURCE_DIFF_TAB_ID`). Keeping this id literal here avoids
    // pulling the batches-store module into pure path utilities used
    // by the runtime contract layer.
    return "source-diff";
  }
  if (
    kind === "office-document" ||
    kind === "office-spreadsheet" ||
    kind === "office-slides"
  ) {
    return `office:${filePath}`;
  }
  if (kind === "image") return `media:image:${filePath}`;
  if (kind === "video") return `media:video:${filePath}`;
  if (kind === "audio") return `media:audio:${filePath}`;
  if (kind === "model3d") return `media:model3d:${filePath}`;
  return `file:${filePath}`;
};

/**
 * Extension guards exported for tests & the resource-card UI.
 */
export const isPreviewableExtension = (extension: string | null): boolean =>
  extension != null && PREFERRED_RESOURCE_EXTS.has(extension);

export const isFallbackPreviewableExtension = (
  extension: string | null,
): boolean => extension != null && FALLBACK_RESOURCE_EXTS.has(extension);
