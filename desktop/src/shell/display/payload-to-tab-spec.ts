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
import { uiState } from "@/platform/ui-state";
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
import { AgentThreadChatTab } from "./AgentThreadChatTab";
import {
  addCanvasHtmlItem,
  setSelectedCanvasHtmlId,
} from "./canvas-tab/canvas-items";
import type { DisplayTabSpec } from "@/features/workspace-display/types";
import { kindForPath } from "@/features/workspace-display/path-to-viewer";
import { SOURCE_DIFF_TAB_ID } from "@/features/workspace-display/source-diff-batches";
import {
  registerWorkspaceDisplayPayloadAdapter,
  type AgentThreadTabArgs,
} from "@/features/workspace-display/open-payload";

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

const GENERATED_MEDIA_ITEMS_KEY = "stella-display-generated-media-items";
const GENERATED_MEDIA_ITEMS_CAP = 300;

const isGeneratedMediaItem = (value: unknown): value is GeneratedMediaItem => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GeneratedMediaItem>;
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "number" &&
    record.asset != null &&
    typeof record.asset === "object" &&
    "kind" in record.asset
  );
};

const loadGeneratedMediaItems = (): GeneratedMediaItem[] => {
  try {
    const parsed = JSON.parse(
      uiState.getItem(GENERATED_MEDIA_ITEMS_KEY) || "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isGeneratedMediaItem)
      .slice(-GENERATED_MEDIA_ITEMS_CAP);
  } catch {
    return [];
  }
};

const persistGeneratedMediaItems = (): void => {
  uiState.setItem(
    GENERATED_MEDIA_ITEMS_KEY,
    JSON.stringify(generatedMediaItems.slice(-GENERATED_MEDIA_ITEMS_CAP)),
  );
};

const generatedMediaItems: GeneratedMediaItem[] = loadGeneratedMediaItems();
const generatedMediaItemIds = new Set(
  generatedMediaItems.map((item) => item.id),
);
// Cached snapshot reference. Refresh only when the underlying list
// actually mutates so consumers can rely on referential equality to
// skip work.
let generatedMediaSnapshot: ReadonlyArray<GeneratedMediaItem> = [];

const generatedMediaListeners = new Set<() => void>();

const refreshGeneratedMediaSnapshot = () => {
  generatedMediaSnapshot = generatedMediaItems.slice();
  for (const listener of generatedMediaListeners) listener();
};

refreshGeneratedMediaSnapshot();

/**
 * Subscribe to generated-media mutations (add/remove). The library
 * overview uses this so its Media section stays live without polling.
 */
export const subscribeGeneratedMediaItems = (
  listener: () => void,
): (() => void) => {
  generatedMediaListeners.add(listener);
  return () => {
    generatedMediaListeners.delete(listener);
  };
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
  const payloads =
    payload.asset.kind === "image" && payload.asset.filePaths.length > 1
      ? payload.asset.filePaths.map((filePath) => ({
          ...payload,
          asset: { kind: "image" as const, filePaths: [filePath] },
        }))
      : [payload];

  for (const entry of payloads) {
    const id = idForMediaPayload(entry);
    if (!generatedMediaItemIds.has(id)) {
      generatedMediaItemIds.add(id);
      generatedMediaItems.push({
        id,
        asset: entry.asset,
        ...(entry.prompt ? { prompt: entry.prompt } : {}),
        ...(entry.capability ? { capability: entry.capability } : {}),
        createdAt: entry.createdAt,
      });
    }
  }
  refreshGeneratedMediaSnapshot();
  persistGeneratedMediaItems();
  return generatedMediaSnapshot;
};

const selectedIdForMediaPayload = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): string =>
  payload.asset.kind === "image" && payload.asset.filePaths.length > 1
    ? `image:${payload.asset.filePaths[0] ?? ""}`
    : idForMediaPayload(payload);

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
  persistGeneratedMediaItems();
  return generatedMediaSnapshot;
};

export const payloadToTabSpec = (
  payload: DisplayTabPayload,
): DisplayTabSpec => {
  const title = getDisplayPayloadTitle(payload);

  switch (payload.kind) {
    case "canvas-html": {
      const items = addCanvasHtmlItem(payload);
      // Select during the click transaction rather than waiting for the
      // mounted Canvas tab's effect. A kept-alive canvas may still be hidden
      // here; synchronously switching it to the keyed loading boundary keeps
      // the old iframe from being rebuilt before the panel shell can paint.
      setSelectedCanvasHtmlId(payload.filePath);
      return {
        id: CANVAS_HTML_TAB_ID,
        kind: "canvas",
        title: "Canvas",
        tooltip: payload.title ?? "HTML canvas",
        metadata: { kind: "canvas-html", items, latest: payload.filePath },
        render: () =>
          createElement(CanvasTabContent, {
            items,
            selectedItemId: payload.filePath,
          }),
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
      const selectedItemId = selectedIdForMediaPayload(payload);
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
        render: () =>
          createElement(MediaTabContent, { items: mediaItems, selectedItemId }),
      };
    }
  }
};

export const createAgentThreadTabSpec = (
  args: AgentThreadTabArgs,
): DisplayTabSpec => ({
  id: `agent-thread:${args.threadId}`,
  kind: "chat",
  title: args.title,
  tooltip: `${args.agentType} · read-only`,
  metadata: {
    kind: "agent-thread",
    threadId: args.threadId,
    conversationId: args.conversationId,
  },
  render: () =>
    createElement(AgentThreadChatTab, {
      threadId: args.threadId,
      conversationId: args.conversationId,
      agentType: args.agentType,
    }),
});

registerWorkspaceDisplayPayloadAdapter({
  payloadToTabSpec,
  createSourceDiffTabSpec,
  createAgentThreadTabSpec,
});
