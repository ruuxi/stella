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
  canvasDisplayTabId,
} from "./canvas-tab/canvas-items";
import type { DisplayTabSpec } from "@/features/workspace-display/types";
import { kindForPath } from "@/features/workspace-display/path-to-viewer";
import { SOURCE_DIFF_TAB_ID } from "@/features/workspace-display/source-diff-batches";
import {
  registerWorkspaceDisplayPayloadAdapter,
  type AgentThreadTabArgs,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  recordArtifactFileEntry,
  setFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";

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

const filePathForMediaItem = (item: GeneratedMediaItem): string | undefined => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths[0];
    case "video":
    case "audio":
    case "model3d":
    case "download":
      return item.asset.filePath;
    case "text":
      return undefined;
  }
};

const basename = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() || filePath;

/**
 * Text assets have no file behind them, so their prompt is the only
 * human-readable handle they have.
 */
const titleForMediaItem = (item: GeneratedMediaItem): string => {
  const filePath = filePathForMediaItem(item);
  if (filePath) return basename(filePath);
  return item.prompt?.trim() || "Text";
};

const toFileEntry = (item: GeneratedMediaItem): FileEntry => {
  const payload: DisplayPayload = {
    kind: "media",
    asset: item.asset,
    createdAt: item.createdAt,
    ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(item.capability ? { capability: item.capability } : {}),
  };
  const filePath = filePathForMediaItem(item);
  return {
    source: "media",
    // The store's own id is already unique per asset, so it doubles as the
    // display-tab id and keeps entry, tab and store row in step.
    id: item.id,
    kind: displayTabKindForPayload(payload),
    title: titleForMediaItem(item),
    ...(filePath ? { filePath } : {}),
    createdAt: item.createdAt,
    payload,
  };
};

const refreshGeneratedMediaSnapshot = () => {
  generatedMediaSnapshot = generatedMediaItems.slice();
  setFileEntries("media", generatedMediaItems.map(toFileEntry));
};

refreshGeneratedMediaSnapshot();

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

/**
 * Every artifact resolves into the Files section: the section is told which
 * file it would land on, and the kinds with no store behind them are indexed
 * so the Files list can offer them after a restart.
 *
 * Background refreshes — the `display:update` IPC, the media materializer —
 * map their payloads through here too, which is why remembering is
 * conditional on the panel being closed. While it is open the file the user
 * is reading wins, and a refreshed spec only changes what's on screen if it
 * happens to be that same file. Pointing the panel at Files is the open
 * verb's job (`openDisplayPayloadTab`), never this one's.
 */
const rememberInFiles = (spec: DisplayTabSpec): DisplayTabSpec => {
  if (!displayTabs.getLayoutSnapshot().panelOpen) {
    sidebarSections.setLocation("files", spec.id);
  }
  return spec;
};

const indexInFiles = (
  spec: DisplayTabSpec,
  payload: DisplayTabPayload,
  filePath?: string,
): DisplayTabSpec => {
  recordArtifactFileEntry({
    id: spec.id,
    kind: spec.kind,
    title: spec.title,
    ...(filePath ? { filePath } : {}),
    // Payloads that carry no timestamp (a URL preview, an office preview ref)
    // are sorted by when they were last opened, which is the only ordering
    // signal they have.
    createdAt: ("createdAt" in payload ? payload.createdAt : null) ?? Date.now(),
    payload,
  });
  return rememberInFiles(spec);
};

export const payloadToTabSpec = (
  payload: DisplayTabPayload,
): DisplayTabSpec => {
  const title = getDisplayPayloadTitle(payload);

  switch (payload.kind) {
    case "canvas-html": {
      const items = addCanvasHtmlItem(payload);
      const item = items.find((entry) => entry.filePath === payload.filePath)!;
      return rememberInFiles({
        id: canvasDisplayTabId(payload.filePath),
        kind: "canvas",
        title: item.title,
        tooltip: payload.filePath,
        metadata: { kind: "canvas-html", filePath: payload.filePath },
        render: () => createElement(CanvasTabContent, { item }),
      });
    }

    case "url":
      return indexInFiles(
        {
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
        },
        payload,
      );

    case "markdown":
      return indexInFiles(
        {
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
        },
        payload,
        payload.filePath,
      );

    case "source-diff":
      // Singleton tab: every source-diff payload maps to the same
      // tab id. The tab content reads from the source-diff batches
      // store, populated by the chat-side click handler before
      // `openTab` is called.
      return indexInFiles(createSourceDiffTabSpec(), payload);

    case "office": {
      const sourcePath = payload.previewRef.sourcePath;
      const kind = kindForPath(sourcePath);
      return indexInFiles(
        {
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
        },
        payload,
        sourcePath,
      );
    }

    case "file-artifact":
      return indexInFiles(
        {
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
        },
        payload,
        payload.filePath,
      );

    case "pdf":
      return indexInFiles(
        {
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
        },
        payload,
        payload.filePath,
      );

    case "trash":
      // Deferred-delete trash is a shell surface rather than an artifact, so
      // it stays out of the Files index.
      return {
        id: "trash:deferred-delete",
        kind: "trash",
        title,
        metadata: { kind: "trash", createdAt: payload.createdAt },
        render: () => createElement(TrashTabContent),
      };

    case "media": {
      const items = addGeneratedMediaItem(payload);
      // A multi-image job lands as several entries; the tab points at the
      // first, which is the one the user clicked through to.
      const itemId = selectedIdForMediaPayload(payload);
      const item = items.find((entry) => entry.id === itemId)!;
      return rememberInFiles({
        id: item.id,
        kind: displayTabKindForPayload(payload),
        title: titleForMediaItem(item),
        ...(payload.capability ? { tooltip: payload.capability } : {}),
        metadata: {
          kind: "media",
          ...(payload.jobId ? { jobId: payload.jobId } : {}),
          ...(payload.capability ? { capability: payload.capability } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
        },
        render: () => createElement(MediaTabContent, { item }),
      });
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
