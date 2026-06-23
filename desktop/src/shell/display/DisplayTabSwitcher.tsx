/**
 * Top-bar display-tab switcher. Shows the active display surface (Home,
 * Chat, Media, Canvas, …) as a single clickable chip; clicking opens a
 * menu listing every open tab so the user can switch surfaces. Lives in
 * the panel chrome (full window) and the mini window's top bar.
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
import "./display-tab-switcher.css";

export const DisplayTabSwitcher = () => {
  const { tabs } = useDisplayTabList();
  const activeTab = useActiveDisplayTab();
  const [open, setOpen] = useState(false);

  if (tabs.length === 0 || !activeTab) return null;

  return (
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
          <span className="display-tab-switcher__title">{activeTab.title}</span>
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
        {tabs.map((tab) => {
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
  );
};
