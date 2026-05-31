/**
 * Display-tab body shown for the "Chat" tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so this tab cannot host a duplicate conversation.
 * The display sidebar opens to a quiet launcher of the other tabs the user
 * might want (Canvas, Media, Store, Trash) — click one and that tab takes over.
 *
 * The Models button in the display sidebar footer toggles an inline engine
 * overlay that takes over the empty space below the launcher; there is no
 * separate Engine display tab.
 *
 * On every other route, the Chat tab keeps rendering the live ChatPanelTab
 * (see `default-tabs.tsx`).
 */
import { useEffect, useState, type ReactNode } from "react";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  openCanvasDisplayTab,
  openMediaDisplayTab,
  openStoreDisplayTab,
  openTrashDisplayTab,
} from "./default-tabs";
import { EngineTabContent } from "./EngineTabContent";
import { useEngineOverlayOpen } from "./engine-overlay-store";
import { DisplaySidebarModelsButton } from "./DisplaySidebarModelsButton";
import type { DisplayTabKind } from "@/features/workspace-display/types";
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

const ENGINE_FADE_MS = 180;

export function ChatHomeOverview() {
  const engineOpen = useEngineOverlayOpen();
  // Keep the engine pane mounted long enough to play the fade-out
  // transition before unmounting. `engineVisible` lags one frame
  // behind on open so the initial opacity:0 → 1 actually transitions.
  const [engineMounted, setEngineMounted] = useState(engineOpen);
  const [engineVisible, setEngineVisible] = useState(engineOpen);

  useEffect(() => {
    if (engineOpen) {
      setEngineMounted(true);
      // Two rAFs so the browser actually paints the initial
      // `opacity:0` frame before React commits `data-visible`; a
      // single rAF lands in the same paint cycle as the mount and
      // skips the transition.
      let innerFrame = 0;
      const outerFrame = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => {
          setEngineVisible(true);
        });
      });
      return () => {
        window.cancelAnimationFrame(outerFrame);
        if (innerFrame) window.cancelAnimationFrame(innerFrame);
      };
    }
    setEngineVisible(false);
    const timer = window.setTimeout(
      () => setEngineMounted(false),
      ENGINE_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [engineOpen]);

  return (
    <div
      className="chat-home-launcher"
      data-engine-open={engineOpen || undefined}
    >
      <ul className="chat-home-launcher__list">
        {ENTRIES.map((entry) => (
          <li key={entry.id}>
            <LauncherButton entry={entry} />
          </li>
        ))}
        <li className="chat-home-launcher__models-row">
          <DisplaySidebarModelsButton />
        </li>
      </ul>
      {engineMounted ? (
        <div
          className="chat-home-launcher__engine"
          data-visible={engineVisible || undefined}
        >
          <EngineTabContent />
        </div>
      ) : null}
    </div>
  );
}
