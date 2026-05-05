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
import type { DisplayPayload } from "@/shared/contracts/display-payload";
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
import type { DisplayTabSpec } from "./types";
import { kindForPath } from "./path-to-viewer";

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
): GeneratedMediaItem[] => {
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
  }
  return [...generatedMediaItems];
};

export const getGeneratedMediaItems = (): GeneratedMediaItem[] => [
  ...generatedMediaItems,
];

/**
 * Remove a generated media item from the shared store. Returns the new
 * snapshot so callers can re-register the tab to surface the change.
 */
export const removeGeneratedMediaItem = (id: string): GeneratedMediaItem[] => {
  const idx = generatedMediaItems.findIndex((item) => item.id === id);
  if (idx === -1) return [...generatedMediaItems];
  generatedMediaItems.splice(idx, 1);
  generatedMediaItemIds.delete(id);
  return [...generatedMediaItems];
};

export const payloadToTabSpec = (payload: DisplayPayload): DisplayTabSpec => {
  if (payload.kind === "html") {
    // `html` payloads render inline in the chat. They never become a
    // tab; the workspace panel doesn't know about them.
    throw new Error("html payloads do not have a tab spec");
  }
  const title = getDisplayPayloadTitle(payload);

  switch (payload.kind) {
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
      return {
        id: `source-diff:${payload.filePath}:${payload.createdAt ?? 0}`,
        kind: "source-diff",
        title,
        tooltip: payload.filePath,
        metadata: { kind: "source-diff", filePath: payload.filePath },
        render: () =>
          createElement(SourceDiffTabContent, {
            filePath: payload.filePath,
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.patch ? { patch: payload.patch } : {}),
          }),
      };

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
