/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import { MediaViewer, type MediaItem } from "../MediaViewer";
import { useScreenRuntime } from "../host/screen-command-bus";
import type { ScreenDefinition } from "../host/screen-types";

const SCREEN_ID = "media_viewer";

const coerceMediaItem = (args: Record<string, unknown>): MediaItem | null => {
  const url = typeof args.url === "string" ? args.url : undefined;
  const localPath = typeof args.localPath === "string" ? args.localPath : undefined;
  if (!url && !localPath) {
    return null;
  }
  const id = typeof args.id === "string" ? args.id : undefined;
  const mimeType = typeof args.mimeType === "string" ? args.mimeType : undefined;
  const label =
    typeof args.label === "string"
      ? args.label
      : id
        ? `Attachment ${id}`
        : "Attachment";
  return {
    id,
    url,
    localPath,
    mimeType,
    label,
  };
};

const MediaViewerScreen = ({ screenId }: { screenId: string; active: boolean }) => {
  const { registerCommand, emitEvent } = useScreenRuntime(screenId);
  const [item, setItem] = useState<MediaItem | null>(null);

  useEffect(
    () =>
      registerCommand("openMedia", (args) => {
        const nextItem = coerceMediaItem(args);
        if (!nextItem) {
          return { ok: false, reason: "openMedia requires a url or localPath." };
        }
        setItem(nextItem);
        emitEvent("media.opened", {
          id: nextItem.id,
          mimeType: nextItem.mimeType,
          label: nextItem.label,
        });
        return { ok: true };
      }),
    [emitEvent, registerCommand],
  );

  useEffect(
    () =>
      registerCommand("clearMedia", () => {
        setItem(null);
        emitEvent("media.cleared", {});
        return { ok: true };
      }),
    [emitEvent, registerCommand],
  );

  return (
    <MediaViewer
      item={item}
      onClear={() => {
        setItem(null);
        emitEvent("media.cleared", {});
      }}
    />
  );
};

export const screen: ScreenDefinition = {
  id: SCREEN_ID,
  title: "Media",
  description: "View attachments and media in the right panel.",
  component: MediaViewerScreen,
  commands: {
    openMedia: {
      description: "Open a media attachment by URL or local path.",
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          localPath: { type: "string" },
          mimeType: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    clearMedia: {
      description: "Clear the currently displayed media.",
      schema: {
        type: "object",
        additionalProperties: false,
      },
    },
  },
};

export default screen;
