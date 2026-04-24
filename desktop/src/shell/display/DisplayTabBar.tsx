/**
 * Tab strip rendered at the top of the Display sidebar. Mirrors the
 * Codex right-panel UI: horizontal scroll, left→right insertion order,
 * close-on-X, click-to-activate.
 *
 * Reorder-by-drag is intentionally out of scope for the current tab strip.
 */

import type { CSSProperties } from "react";
import { displayTabs, useDisplayTabs } from "./tab-store";
import { DisplayTabIcon } from "./icons";

const closeIconStyle: CSSProperties = {
  width: 12,
  height: 12,
};

export const DisplayTabBar = () => {
  const { tabs, activeTabId } = useDisplayTabs();
  if (tabs.length === 0) return null;

  return (
    <div className="display-sidebar__tabbar" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`display-sidebar__tab${
              isActive ? " display-sidebar__tab--active" : ""
            }`}
            role="tab"
            aria-selected={isActive}
            title={tab.tooltip ?? tab.title}
          >
            <button
              type="button"
              className="display-sidebar__tab-button"
              onClick={() => displayTabs.activateTab(tab.id)}
            >
              <DisplayTabIcon kind={tab.kind} size={20} />
              <span className="display-sidebar__tab-title">{tab.title}</span>
            </button>
            <button
              type="button"
              className="display-sidebar__tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                displayTabs.closeTab(tab.id);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={closeIconStyle}
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
};
