/**
 * "+" affordance to the right of the workspace-panel tab strip. Opens a
 * dropdown listing standalone tabs the user can spawn directly:
 *
 *   - Chat   → activates the panel chat tab (always available; on home it
 *              renders the activity / files overview).
 *   - Store  → opens the Store side panel tab.
 *   - Trash  → opens the deferred-delete Trash tab.
 *
 * Content tabs (PDF, image, html…) are intentionally excluded — those
 * are produced by display payloads, not user choice.
 */

import { Plus } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { displayTabs, useDisplayTabList } from "./tab-store";
import { DisplayTabIcon } from "./icons";
import type { DisplayTabKind } from "./types";
import {
  CANVAS_DISPLAY_TAB_ID,
  CHAT_DISPLAY_TAB_ID,
  MEDIA_DISPLAY_TAB_ID,
  openCanvasDisplayTab,
  openChatDisplayTab,
  openMediaDisplayTab,
  openStoreDisplayTab,
  openTrashDisplayTab,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
} from "./default-tabs";

type AddMenuOption = {
  id: string;
  label: string;
  kind: DisplayTabKind;
  onSelect: () => void;
};

export const DisplayTabAddMenu = () => {
  const { tabs } = useDisplayTabList();
  const knownIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs]);

  const openOrActivate = useCallback(
    (tabId: string, open: () => void) => {
      if (knownIds.has(tabId)) {
        displayTabs.activateTab(tabId);
        return;
      }
      open();
    },
    [knownIds],
  );

  const openChat = useCallback(() => {
    openOrActivate(CHAT_DISPLAY_TAB_ID, () => openChatDisplayTab());
  }, [openOrActivate]);

  const openStore = useCallback(() => {
    openOrActivate(STORE_DISPLAY_TAB_ID, openStoreDisplayTab);
  }, [openOrActivate]);

  const openMedia = useCallback(() => {
    openOrActivate(MEDIA_DISPLAY_TAB_ID, openMediaDisplayTab);
  }, [openOrActivate]);

  const openCanvas = useCallback(() => {
    openOrActivate(CANVAS_DISPLAY_TAB_ID, openCanvasDisplayTab);
  }, [openOrActivate]);

  const openTrash = useCallback(() => {
    openOrActivate(TRASH_DISPLAY_TAB_ID, openTrashDisplayTab);
  }, [openOrActivate]);

  const options: AddMenuOption[] = [
    { id: "chat", label: "Chat", kind: "chat", onSelect: openChat },
    { id: "canvas", label: "Canvas", kind: "canvas", onSelect: openCanvas },
    { id: "media", label: "Media", kind: "media", onSelect: openMedia },
    { id: "store", label: "Store", kind: "store", onSelect: openStore },
    { id: "trash", label: "Trash", kind: "trash", onSelect: openTrash },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shell-topbar-tab__add"
          aria-label="Open another tab"
          title="Open another tab"
        >
          <Plus size={14} strokeWidth={1.85} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="display-tab-add-menu"
      >
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            onSelect={() => opt.onSelect()}
            className="display-tab-add-menu__item"
          >
            <DisplayTabIcon kind={opt.kind} size={18} />
            <span>{opt.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
