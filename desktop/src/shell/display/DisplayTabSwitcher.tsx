/**
 * Top-bar display-tab switcher. A standalone Home icon returns to the home
 * launcher, and a separate chip shows the active non-home surface (Chat,
 * Media, Canvas, …); clicking the chip opens a menu listing the other open
 * surfaces. Lives in the panel chrome (full window) and the mini window's
 * top bar.
 */

import { useState } from "react";
import { ChevronDown } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  displayTabs,
  useActiveDisplayTab,
  useDisplayTabList,
} from "@/features/workspace-display/tab-store";
import {
  HOME_DISPLAY_TAB_ID,
  openHomeDisplayTab,
} from "@/features/workspace-display/default-tabs";
import "./display-tab-switcher.css";

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
            {switchableTabs.map((tab) => {
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
            })}
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
