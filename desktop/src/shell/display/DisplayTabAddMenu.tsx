/**
 * "+" affordance to the right of the workspace-panel tab strip. Opens a
 * dropdown listing standalone tabs the user can spawn directly:
 *
 *   - Chat   → activates the panel chat tab (always available; on home it
 *              renders the activity / files overview).
 *   - Store  → navigates to `/store`.
 *   - Ideas  → opens the Ideas tab.
 *   - Trash  → opens the deferred-delete Trash tab.
 *
 * Content tabs (PDF, image, html…) are intentionally excluded — those
 * are produced by display payloads, not user choice.
 */

import { Plus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { displayTabs, useDisplayTabs } from "./tab-store";
import { DisplayTabIcon } from "./icons";
import type { DisplayTabKind } from "./types";
import {
  CHAT_DISPLAY_TAB_ID,
  IDEAS_DISPLAY_TAB_ID,
  openChatDisplayTab,
  openIdeasDisplayTab,
  openTrashDisplayTab,
  TRASH_DISPLAY_TAB_ID,
} from "./default-tabs";

type AddMenuOption = {
  id: string;
  label: string;
  kind: DisplayTabKind;
  onSelect: () => void;
};

export const DisplayTabAddMenu = () => {
  const navigate = useNavigate();
  const { tabs } = useDisplayTabs();
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
    void navigate({ to: "/store", search: { tab: "discover" } });
  }, [navigate]);

  const openIdeas = useCallback(() => {
    openOrActivate(IDEAS_DISPLAY_TAB_ID, openIdeasDisplayTab);
  }, [openOrActivate]);

  const openTrash = useCallback(() => {
    openOrActivate(TRASH_DISPLAY_TAB_ID, openTrashDisplayTab);
  }, [openOrActivate]);

  const options: AddMenuOption[] = [
    { id: "chat", label: "Chat", kind: "chat", onSelect: openChat },
    { id: "store", label: "Store", kind: "store", onSelect: openStore },
    { id: "ideas", label: "Ideas", kind: "ideas", onSelect: openIdeas },
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
