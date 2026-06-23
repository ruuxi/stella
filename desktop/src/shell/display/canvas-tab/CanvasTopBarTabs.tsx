/**
 * Canvas picker in the display panel top chrome — shows the active canvas
 * title and a +n affordance; both open the same switcher menu.
 */

import { useState, useSyncExternalStore } from "react";
import { Image, X } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useActiveDisplayTab } from "@/features/workspace-display/tab-store";
import { CANVAS_DISPLAY_TAB_ID } from "@/features/workspace-display/default-tabs";
import {
  getCanvasHtmlItems,
  getSelectedCanvasHtmlId,
  removeCanvasHtmlItem,
  setSelectedCanvasHtmlId,
  subscribeCanvasHtmlItems,
  subscribeSelectedCanvasHtmlId,
} from "./canvas-items";
import "./canvas-topbar-switcher.css";

const useCanvasItems = () =>
  useSyncExternalStore(subscribeCanvasHtmlItems, getCanvasHtmlItems, () => []);

const useSelectedCanvasId = () =>
  useSyncExternalStore(
    subscribeSelectedCanvasHtmlId,
    getSelectedCanvasHtmlId,
    () => null,
  );

export const CanvasTopBarTabs = () => {
  const activeTab = useActiveDisplayTab();
  const items = useCanvasItems();
  const selectedId = useSelectedCanvasId();
  const [open, setOpen] = useState(false);

  // The general DisplayTabSwitcher already names the Canvas surface, so the
  // per-canvas switcher only adds value when there are multiple canvases to
  // move between.
  if (activeTab?.id !== CANVAS_DISPLAY_TAB_ID || items.length <= 1) {
    return null;
  }

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items.at(-1) ?? null;
  if (!selectedItem) return null;

  const extraCount = items.length - 1;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className="canvas-topbar-switcher">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="canvas-topbar-switcher__segment canvas-topbar-switcher__segment--current"
            aria-label={`Canvas: ${selectedItem.title}`}
          >
            <Image size={14} strokeWidth={1.4} aria-hidden />
            <span className="canvas-topbar-switcher__title">
              {selectedItem.title}
            </span>
          </button>
        </DropdownMenuTrigger>
        {extraCount > 0 ? (
          <button
            type="button"
            className="canvas-topbar-switcher__segment canvas-topbar-switcher__segment--more"
            aria-label={`${extraCount} more canvases`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            +{extraCount}
          </button>
        ) : null}
      </div>
      <DropdownMenuContent
        className="canvas-topbar-menu display-tab-add-menu"
        align="start"
        side="bottom"
        sideOffset={6}
      >
        {items.map((item) => {
          const isActive = item.id === selectedItem.id;
          return (
            <DropdownMenuItem
              key={item.id}
              className={`canvas-topbar-menu__item display-tab-add-menu__item${
                isActive ? " canvas-topbar-menu__item--active" : ""
              }`}
              onSelect={() => setSelectedCanvasHtmlId(item.id)}
            >
              <span data-slot="dropdown-menu-item-icon">
                <Image size={16} strokeWidth={1.4} aria-hidden />
              </span>
              <span className="canvas-topbar-menu__label">{item.title}</span>
              <button
                type="button"
                className="canvas-topbar-menu__close"
                aria-label={`Close ${item.title}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  removeCanvasHtmlItem(item.filePath);
                }}
              >
                <X size={12} strokeWidth={2.2} />
              </button>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
