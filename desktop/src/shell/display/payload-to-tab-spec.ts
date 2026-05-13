/**
 * Bridge from the `DisplayPayload` IPC contract (one-payload-at-a-time,
 * used by the media materializer and a few other channels) to the
 * `DisplayTabSpec` model.
 *
 * Keeping the bridge isolated means the worker / IPC / Convex hooks don't
 * have to learn about the tab manager — they keep speaking
 * `DisplayPayload` and a single mapper turns each one into a tab spec at
 * the renderer boundary.
 */

import { createElement } from "react";
import type {
  DisplayPayload,
  DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { getDisplayPayloadTitle } from "@/shared/contracts/display-payload";
import {
  UrlTabContent,
  MarkdownTabContent,
  SourceDiffTabContent,
  PdfTabContent,
  OfficeTabContent,
  OfficeFileTabContent,
  DelimitedTableTabContent,
  MediaTabContent,
  TrashTabContent,
} from "./tab-content";
import { CanvasTabContent } from "./canvas-tab/CanvasTabContent";
import { addCanvasHtmlItem } from "./canvas-tab/canvas-items";
import type { DisplayTabKind, DisplayTabSpec } from "./types";
import { kindForPath } from "./path-to-viewer";
import { SOURCE_DIFF_TAB_ID } from "./source-diff-batches";

export const CANVAS_HTML_TAB_ID = "canvas:html";

/**
 * Spec for the singleton "Code changes" tab. All source-diff payloads
 * activate this one tab; the content subscribes to the source-diff
 * batches store, so the click side effect (pushing the turn's batch
 * into the store) drives what renders rather than per-payload props.
 */
export const createSourceDiffTabSpec = (): DisplayTabSpec => ({
  id: SOURCE_DIFF_TAB_ID,
  kind: "source-diff",
  title: "Code changes",
  tooltip: "Recent file changes",
  metadata: { kind: "source-diff" },
  render: () => createElement(SourceDiffTabContent),
});

export const GENERATED_MEDIA_TAB_ID = "media:generated";
export const GENERATED_IMAGE_TAB_ID = GENERATED_MEDIA_TAB_ID;

export type GeneratedMediaItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};

const generatedMediaItems: GeneratedMediaItem[] = [];
const generatedMediaItemIds = new Set<string>();
// Cached snapshot reference. Refresh only when the underlying list
// actually mutates so consumers can rely on referential equality to
// skip work.
let generatedMediaSnapshot: ReadonlyArray<GeneratedMediaItem> = [];

const refreshGeneratedMediaSnapshot = () => {
  generatedMediaSnapshot = generatedMediaItems.slice();
};

const hashText = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

const idForMediaPayload = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): string => {
  const { asset } = payload;
  switch (asset.kind) {
    case "image":
      return `image:${asset.filePaths.join("|")}`;
    case "video":
    case "audio":
    case "model3d":
    case "download":
      return `${asset.kind}:${asset.filePath}`;
    case "text":
      return `text:${payload.jobId ?? `${payload.createdAt}:${hashText(asset.text)}`}`;
  }
};

const addGeneratedMediaItem = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): ReadonlyArray<GeneratedMediaItem> => {
  const id = idForMediaPayload(payload);
  if (!generatedMediaItemIds.has(id)) {
    generatedMediaItemIds.add(id);
    generatedMediaItems.push({
      id,
      asset: payload.asset,
      ...(payload.prompt ? { prompt: payload.prompt } : {}),
      ...(payload.capability ? { capability: payload.capability } : {}),
      createdAt: payload.createdAt,
    });
    refreshGeneratedMediaSnapshot();
  }
  return generatedMediaSnapshot;
};

export const getGeneratedMediaItems = (): ReadonlyArray<GeneratedMediaItem> =>
  generatedMediaSnapshot;

/**
 * Remove a generated media item from the shared store. Returns the new
 * snapshot so callers can re-register the tab to surface the change.
 */
export const removeGeneratedMediaItem = (
  id: string,
): ReadonlyArray<GeneratedMediaItem> => {
  const idx = generatedMediaItems.findIndex((item) => item.id === id);
  if (idx === -1) return generatedMediaSnapshot;
  generatedMediaItems.splice(idx, 1);
  generatedMediaItemIds.delete(id);
  refreshGeneratedMediaSnapshot();
  return generatedMediaSnapshot;
};

/**
 * Pure mapping from a `DisplayPayload` to the `DisplayTabKind` used by
 * the icon set. Lifted out of `payloadToTabSpec` so callers that just
 * need the icon (e.g. the home overview's recent-files list) don't have
 * to invoke the side-effecting tab-spec builder.
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

export const payloadToTabSpec = (
  payload: DisplayTabPayload,
): DisplayTabSpec => {
  const title = getDisplayPayloadTitle(payload);

  switch (payload.kind) {
    case "canvas-html": {
      const items = addCanvasHtmlItem(payload);
      return {
        id: CANVAS_HTML_TAB_ID,
        kind: "canvas",
        title: "Canvas",
        tooltip: payload.title ?? "HTML canvas",
        metadata: { kind: "canvas-html", items, latest: payload.filePath },
        render: () => createElement(CanvasTabContent, { items }),
      };
    }

    case "url":
      return {
        id: payload.tabId,
        kind: "url",
        title,
        ...(payload.tooltip ? { tooltip: payload.tooltip } : {}),
        metadata: { kind: "url", url: payload.url },
        render: () =>
          createElement(UrlTabContent, {
            url: payload.url,
            title,
          }),
      };

    case "markdown":
      return {
        id: `markdown:${payload.filePath}`,
        kind: "markdown",
        title,
        tooltip: payload.filePath,
        metadata: { kind: "markdown", filePath: payload.filePath },
        render: () =>
          createElement(MarkdownTabContent, {
            filePath: payload.filePath,
            ...(payload.title ? { title: payload.title } : {}),
          }),
      };

    case "source-diff":
      // Singleton tab: every source-diff payload maps to the same
      // tab id. The tab content reads from the source-diff batches
      // store, populated by the chat-side click handler before
      // `openTab` is called.
      return createSourceDiffTabSpec();

    case "office": {
      const sourcePath = payload.previewRef.sourcePath;
      const kind = kindForPath(sourcePath);
      return {
        id: `office:${sourcePath}`,
        kind:
          kind === "office-spreadsheet" || kind === "office-slides"
            ? kind
            : "office-document",
        title,
        tooltip: sourcePath,
        metadata: { kind: "office", sourcePath },
        render: () =>
          createElement(OfficeTabContent, { previewRef: payload.previewRef }),
      };
    }

    case "file-artifact":
      return {
        id: `file-artifact:${payload.filePath}`,
        kind:
          payload.artifactKind === "delimited-table"
            ? "office-spreadsheet"
            : payload.artifactKind,
        title,
        tooltip: payload.filePath,
        metadata: {
          kind: "file-artifact",
          filePath: payload.filePath,
          artifactKind: payload.artifactKind,
        },
        render: () =>
          payload.artifactKind === "delimited-table"
            ? createElement(DelimitedTableTabContent, {
                filePath: payload.filePath,
                title,
              })
            : createElement(OfficeFileTabContent, {
                filePath: payload.filePath,
                title,
                refreshToken: payload.createdAt,
              }),
      };

    case "pdf":
      return {
        id: `pdf:${payload.filePath}`,
        kind: "pdf",
        title,
        tooltip: payload.filePath,
        metadata: { kind: "pdf", filePath: payload.filePath },
        render: () =>
          createElement(PdfTabContent, {
            filePath: payload.filePath,
            ...(payload.title ? { title: payload.title } : {}),
          }),
      };

    case "trash":
      return {
        id: "trash:deferred-delete",
        kind: "trash",
        title,
        metadata: { kind: "trash", createdAt: payload.createdAt },
        render: () => createElement(TrashTabContent),
      };

    case "media": {
      const baseMeta = {
        ...(payload.jobId ? { jobId: payload.jobId } : {}),
        ...(payload.capability ? { capability: payload.capability } : {}),
        ...(payload.prompt ? { prompt: payload.prompt } : {}),
      };
      const mediaItems = addGeneratedMediaItem(payload);
      return {
        id: GENERATED_MEDIA_TAB_ID,
        kind: "media",
        title: "Media",
        tooltip: "Generated media",
        metadata: {
          kind: "media",
          items: mediaItems,
          ...baseMeta,
        },
        render: () => createElement(MediaTabContent, { items: mediaItems }),
      };
    }
  }
};
