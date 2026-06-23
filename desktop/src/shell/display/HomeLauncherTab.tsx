/**
 * Display-tab body shown for the Home tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so this surface never hosts a duplicate
 * conversation. Instead it's a quiet launcher of the other display
 * surfaces the user might want (Canvas, Media, Trash) — click one and that
 * tab takes over. Activity / files / schedules already live in the left
 * sidebar, so this launcher doesn't repeat them, and Models lives in the
 * sidebar footer rather than here.
 */
import type { ReactNode } from "react";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import type { DisplayTabKind } from "@/features/workspace-display/types";
import {
  openCanvasDisplayTab,
  openMediaDisplayTab,
  openTrashDisplayTab,
} from "./default-tabs";
import "./chat-home-overview.css";

type LauncherEntry = {
  id: string;
  label: string;
  description: string;
  kind: DisplayTabKind;
  onSelect: () => void;
};

const ENTRIES: ReadonlyArray<LauncherEntry> = [
  {
    id: "canvas",
    label: "Canvas",
    description: "Pages Stella has put together",
    kind: "canvas",
    onSelect: openCanvasDisplayTab,
  },
  {
    id: "media",
    label: "Media",
    description: "Generated images, video, and audio",
    kind: "media",
    onSelect: openMediaDisplayTab,
  },
  {
    id: "trash",
    label: "Trash",
    description: "Things you've recently deleted",
    kind: "trash",
    onSelect: openTrashDisplayTab,
  },
];

function LauncherButton({ entry }: { entry: LauncherEntry }): ReactNode {
  return (
    <button
      type="button"
      className="chat-home-launcher__entry"
      onClick={entry.onSelect}
    >
      <span className="chat-home-launcher__entry-icon" aria-hidden="true">
        <DisplayTabIcon kind={entry.kind} size={20} />
      </span>
      <span className="chat-home-launcher__entry-text">
        <span className="chat-home-launcher__entry-label">{entry.label}</span>
        <span className="chat-home-launcher__entry-description">
          {entry.description}
        </span>
      </span>
    </button>
  );
}

export function HomeLauncherTab() {
  return (
    <div className="chat-home-launcher">
      <ul className="chat-home-launcher__list">
        {ENTRIES.map((entry) => (
          <li key={entry.id}>
            <LauncherButton entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}
