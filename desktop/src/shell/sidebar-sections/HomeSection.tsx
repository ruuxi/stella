/**
 * Home — the agent activity index, with search folded in as a control.
 *
 * Sub-location (`sidebarSections` → `locations.home`) is the display-tab id of
 * an agent-thread drill-down, or `null` for the thread list.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  displaySearchStore,
  useDisplaySearchFocusRequest,
  useDisplaySearchOpen,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { openEngineDisplayTab } from "@/features/workspace-display/default-tabs";
import {
  useDisplayPanelOpen,
  useDisplayTabList,
} from "@/features/workspace-display/tab-store";
import { ModelsPicker } from "@/global/settings/ModelsPicker";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { ChevronLeft, Search, SlidersHorizontal } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./home-search.css";

export const shouldHoldSearchLayout = (
  inputValue: string,
  deferredQuery: string,
): boolean => inputValue.trim().length > 0 || deferredQuery.trim().length > 0;

function HomeOverview() {
  const query = useDisplaySearchQuery();
  const searchOpen = useDisplaySearchOpen();
  const focusRequest = useDisplaySearchFocusRequest();
  const panelOpen = useDisplayPanelOpen();
  const activeSection = useActiveSidebarSection();
  const modelsPickerOpen = useEngineOverlayOpen();
  const [inputValue, setInputValue] = useState(query);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!searchOpen) {
      setInputValue("");
      return;
    }
    const timer = window.setTimeout(() => {
      displaySearchStore.setQuery(inputValue);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [inputValue, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, searchOpen]);

  useEffect(() => {
    if (searchOpen && (!panelOpen || activeSection !== "home")) {
      displaySearchStore.close();
    }
  }, [activeSection, panelOpen, searchOpen]);

  const searching =
    searchOpen && shouldHoldSearchLayout(inputValue, deferredQuery);
  const renderEmpty = useCallback(
    () => (
      <div className="sidebar-section__empty">
        {deferredQuery.trim()
          ? "Nothing matches that search."
          : "Activity will show up here as Stella works."}
      </div>
    ),
    [deferredQuery],
  );

  return (
    <div className="sidebar-search" data-searching={searching || undefined}>
      {searchOpen ? (
        <div className="sidebar-search__field">
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="sidebar-search__input"
            value={inputValue}
            placeholder="Search activity, files, and more"
            onChange={(event) => setInputValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") displaySearchStore.close();
            }}
            aria-label="Search activity, files, and more"
          />
        </div>
      ) : null}
      <div className="sidebar-search__body">
        <WorkspaceSections
          query={searchOpen ? deferredQuery : ""}
          variant="overview"
          searchMode="quick"
          includeUserApps
          renderEmpty={renderEmpty}
        />
      </div>
      <div className="sidebar-home-footer">
        <ModelsPicker
          open={modelsPickerOpen}
          onOpenChange={engineOverlay.setOpen}
          side="top"
          align="end"
          trigger={
            <button
              type="button"
              className="pill-btn sidebar-home-models-button"
            >
              <SlidersHorizontal size={14} strokeWidth={1.75} />
              Models
            </button>
          }
        />
      </div>
    </div>
  );
}

export function HomeSection() {
  const openTabId = useSidebarSectionLocation("home");
  const { tabs } = useDisplayTabList();

  useEffect(() => {
    const handleOpenModelPicker = () => openEngineDisplayTab();
    window.addEventListener("stella:open-model-picker", handleOpenModelPicker);
    return () => {
      window.removeEventListener(
        "stella:open-model-picker",
        handleOpenModelPicker,
      );
    };
  }, []);

  // A remembered id can outlive its tab (the registry is not persisted across
  // launches). Falling back to the list is the graceful degradation.
  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) {
    return <HomeOverview />;
  }

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("home")}
          aria-label="Back to home"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Home
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
