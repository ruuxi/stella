/**
 * Display-tab body shown for the "Chat" tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so this tab cannot host a duplicate conversation.
 * The home workspace strip already surfaces activity, files, and schedules,
 * so the display sidebar would just repeat the same content. Instead the
 * sidebar opens to a quiet launcher of the other tabs the user might want
 * (Canvas, Media, Store, Trash) — click one and that tab takes over.
 *
 * On every other route, the Chat tab keeps rendering the live ChatPanelTab
 * (see `default-tabs.tsx`).
 */
import type { ReactNode } from "react";
import { DisplayTabIcon } from "./icons";
import {
  openCanvasDisplayTab,
  openMediaDisplayTab,
  openStoreDisplayTab,
  openTrashDisplayTab,
} from "./default-tabs";
import type { DisplayTabKind } from "./types";
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
    id: "store",
    label: "Store",
    description: "Your add-ons and recent changes",
    kind: "store",
    onSelect: openStoreDisplayTab,
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

export function ChatHomeOverview() {
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
