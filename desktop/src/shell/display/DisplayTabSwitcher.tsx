/**
 * Top-bar display-tab switcher. A standalone Home icon returns to the home
 * launcher, and a separate chip shows the active non-home surface (Chat,
 * Store, an open file, …); clicking the chip opens a menu listing the other
 * open surfaces. Lives in the panel chrome (full window) and the mini
 * window's top bar.
 */

import { useState } from "react";
import { ChevronDown } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  displayTabs,
  useActiveDisplayTab,
  useDisplayTabList,
} from "@/features/workspace-display/tab-store";
import type { DisplayTab } from "@/features/workspace-display/types";
import {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
  openHomeDisplayTab,
} from "@/features/workspace-display/default-tabs";
import "./display-tab-switcher.css";

/**
 * Fixed destinations, in pin order. These never scroll away — with many
 * ephemeral surfaces (open files, apps) the list splits into a pinned block
 * and a scrollable rest, so Chat/Store/Trash stay reachable however long the
 * file list grows.
 */
const PINNED_TAB_IDS: readonly string[] = [
  CHAT_DISPLAY_TAB_ID,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
];

const pinnedRank = (tab: DisplayTab): number => PINNED_TAB_IDS.indexOf(tab.id);

export const DisplayTabSwitcher = () => {
  const { tabs } = useDisplayTabList();
  const activeTab = useActiveDisplayTab();
  const [open, setOpen] = useState(false);

  if (tabs.length === 0 || !activeTab) return null;

  const homeActive = activeTab.id === HOME_DISPLAY_TAB_ID;
  const switchableTabs = tabs.filter((tab) => tab.id !== HOME_DISPLAY_TAB_ID);

  const goHome = () => {
    if (tabs.some((tab) => tab.id === HOME_DISPLAY_TAB_ID)) {
      displayTabs.activateTab(HOME_DISPLAY_TAB_ID);
    } else {
      openHomeDisplayTab();
    }
  };

  return (
    <div className="display-tab-switcher-group">
      <button
        type="button"
        className="display-tab-home"
        data-active={homeActive || undefined}
        aria-label="Home"
        title="Home"
        onClick={goHome}
      >
        <DisplayTabIcon kind="home" size={16} />
      </button>

      {homeActive ? null : switchableTabs.length > 1 ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="display-tab-switcher"
              aria-label={`Display surface: ${activeTab.title}`}
            >
              <span className="display-tab-switcher__icon" aria-hidden>
                <DisplayTabIcon kind={activeTab.kind} size={15} />
              </span>
              <span className="display-tab-switcher__title">
                {activeTab.title}
              </span>
              <ChevronDown
                size={13}
                strokeWidth={1.6}
                className="display-tab-switcher__chevron"
                aria-hidden
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="display-tab-switcher-menu display-tab-add-menu"
            align="start"
            side="bottom"
            sideOffset={6}
          >
            {(() => {
              const renderItem = (tab: (typeof switchableTabs)[number]) => {
                const isActive = tab.id === activeTab.id;
                return (
                  <DropdownMenuItem
                    key={tab.id}
                    className={`display-tab-switcher-menu__item display-tab-add-menu__item${
                      isActive ? " display-tab-switcher-menu__item--active" : ""
                    }`}
                    onSelect={() => displayTabs.activateTab(tab.id)}
                  >
                    <span data-slot="dropdown-menu-item-icon">
                      <DisplayTabIcon kind={tab.kind} size={16} />
                    </span>
                    <span className="display-tab-switcher-menu__label">
                      {tab.title}
                    </span>
                  </DropdownMenuItem>
                );
              };

              const pinned = switchableTabs
                .filter((tab) => pinnedRank(tab) !== -1)
                .sort((a, b) => pinnedRank(a) - pinnedRank(b));
              const dynamic = switchableTabs.filter(
                (tab) => pinnedRank(tab) === -1,
              );

              // Fixed destinations stay put; only the ephemeral surfaces
              // (open files, user apps) scroll once the list grows past the
              // menu's viewport cap.
              return (
                <>
                  {pinned.map(renderItem)}
                  {pinned.length > 0 && dynamic.length > 0 ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {dynamic.length > 0 ? (
                    <div className="display-tab-switcher-menu__scroll">
                      {dynamic.map(renderItem)}
                    </div>
                  ) : null}
                </>
              );
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="display-tab-switcher display-tab-switcher--static">
          <span className="display-tab-switcher__icon" aria-hidden>
            <DisplayTabIcon kind={activeTab.kind} size={15} />
          </span>
          <span className="display-tab-switcher__title">{activeTab.title}</span>
        </div>
      )}
    </div>
  );
};
