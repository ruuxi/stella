/**
 * Bridge from the `DisplayPayload` IPC contract (one-payload-at-a-time,
 * used by the media materializer and a few other channels) to the
 * `DisplayTabSpec` model.
 *
 * Keeping the bridge isolated means the worker / IPC / Convex hooks don't
 * have to learn about the tab manager — they keep speaking
 * `DisplayPayload` and a single mapper turns each one into a tab spec at
 * the renderer boundary.
 *
 * `html` payloads from the orchestrator's `Display` tool intentionally
 * bypass this bridge — they render inline in the chat (see
 * `InlineHtmlCanvas`) instead of opening a tab.
 */

import { createElement } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { getDisplayPayloadTitle } from "@/shared/contracts/display-payload";
import {
  UrlTabContent,
  MarkdownTabContent,
  SourceDiffTabContent,
  ImageTabContent,
  PdfTabContent,
  OfficeTabContent,
  OfficeFileTabContent,
  DelimitedTableTabContent,
  VideoTabContent,
  AudioTabContent,
  Model3dTabContent,
  DownloadTabContent,
  TextTabContent,
  TrashTabContent,
} from "./tab-content";
import type { DisplayTabSpec } from "./types";
import { basenameOf, kindForPath } from "./path-to-viewer";

/**
 * Stable hash for a list of file paths (used as part of media-image tab
 * ids). Sorted so that `[a, b]` and `[b, a]` collapse to the same tab.
 */
const stableJoin = (paths: string[]): string => [...paths].sort().join("|");

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
      const asset = payload.asset;
      const baseMeta = {
        ...(payload.jobId ? { jobId: payload.jobId } : {}),
        ...(payload.capability ? { capability: payload.capability } : {}),
        ...(payload.prompt ? { prompt: payload.prompt } : {}),
      };
      switch (asset.kind) {
        case "image":
          return {
            id: `media:image:${stableJoin(asset.filePaths)}`,
            kind: "image",
            title,
            tooltip: asset.filePaths.map(basenameOf).join(", "),
            metadata: {
              kind: "image",
              filePaths: asset.filePaths,
              ...baseMeta,
            },
            render: () =>
              createElement(ImageTabContent, {
                filePaths: asset.filePaths,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        case "video":
          return {
            id: `media:video:${asset.filePath}`,
            kind: "video",
            title,
            tooltip: asset.filePath,
            metadata: { kind: "video", filePath: asset.filePath, ...baseMeta },
            render: () =>
              createElement(VideoTabContent, {
                filePath: asset.filePath,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        case "audio":
          return {
            id: `media:audio:${asset.filePath}`,
            kind: "audio",
            title,
            tooltip: asset.filePath,
            metadata: { kind: "audio", filePath: asset.filePath, ...baseMeta },
            render: () =>
              createElement(AudioTabContent, {
                filePath: asset.filePath,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        case "model3d":
          return {
            id: `media:model3d:${asset.filePath}`,
            kind: "model3d",
            title,
            tooltip: asset.filePath,
            metadata: {
              kind: "model3d",
              filePath: asset.filePath,
              ...baseMeta,
            },
            render: () =>
              createElement(Model3dTabContent, {
                filePath: asset.filePath,
                label: asset.label,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        case "download":
          return {
            id: `media:download:${asset.filePath}`,
            kind: "download",
            title,
            tooltip: asset.filePath,
            metadata: {
              kind: "download",
              filePath: asset.filePath,
              ...baseMeta,
            },
            render: () =>
              createElement(DownloadTabContent, {
                filePath: asset.filePath,
                label: asset.label,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        case "text": {
          // Text blobs don't have a path, so the id is keyed off the
          // payload's `createdAt` — re-emitting the same blob within one ms
          // would dedupe (which is fine: it's the same content).
          return {
            id: `media:text:${payload.createdAt}`,
            kind: "text",
            title,
            metadata: { kind: "text", ...baseMeta },
            render: () =>
              createElement(TextTabContent, {
                text: asset.text,
                ...(payload.prompt ? { prompt: payload.prompt } : {}),
                ...(payload.capability
                  ? { capability: payload.capability }
                  : {}),
              }),
          };
        }
      }
    }
  }
};
