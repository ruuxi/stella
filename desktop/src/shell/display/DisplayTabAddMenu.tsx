/**
 * "+" affordance to the right of the workspace-panel tab strip. It opens the
 * sidebar Home tab, whose launcher contains the standalone surfaces users can
 * spawn directly.
 */

import { Plus } from "lucide-react";
import { useMatchRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { displayTabs, useDisplayTabList } from "./tab-store";
import {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  openChatDisplayTab,
  openHomeDisplayTab,
} from "./default-tabs";

export const DisplayTabAddMenu = () => {
  const { tabs } = useDisplayTabList();
  const matchRoute = useMatchRoute();
  const isOnHomeChatRoute = Boolean(matchRoute({ to: "/chat" }));

  const openHome = useCallback(() => {
    const tabId = isOnHomeChatRoute ? CHAT_DISPLAY_TAB_ID : HOME_DISPLAY_TAB_ID;
    if (tabs.some((tab) => tab.id === tabId)) {
      displayTabs.activateTab(tabId);
      return;
    }
    if (isOnHomeChatRoute) openChatDisplayTab();
    else openHomeDisplayTab();
  }, [isOnHomeChatRoute, tabs]);

  return (
    <button
      type="button"
      className="shell-topbar-tab__add"
      aria-label="Open home tab"
      title="Open home tab"
      onClick={openHome}
    >
      <Plus size={14} strokeWidth={1.85} />
    </button>
  );
};
