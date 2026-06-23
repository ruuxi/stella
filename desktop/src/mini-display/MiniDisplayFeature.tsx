import { lazy, Suspense, useLayoutEffect, type RefObject } from "react";
import { PanelRight, X } from "@/ui/icons";
import "../shared/styles/app-components.css";
import "../shell/display/chat-home-overview.css";
import "./mini-display.css";

import {
  displayTabs,
  useDisplayPanelOpen,
  useDisplayTabList,
} from "../features/workspace-display/tab-store";
import { DisplayTabIcon } from "../features/workspace-display/icons";
import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "../shared/contracts/display-payload";

const MINI_HOME_DISPLAY_TAB_ID = "mini:home";

type MiniDisplayOpenOptions = Parameters<typeof displayTabs.openTab>[1];

const LazyRightSidebar = lazy(() =>
  import("../shell/RightSidebar").then((module) => ({
    default: module.RightSidebar,
  })),
);

const openDisplayPayload = async (
  payload: DisplayTabPayload,
  opts?: MiniDisplayOpenOptions,
) => {
  const { payloadToTabSpec } = await import(
    "../shell/display/payload-to-tab-spec"
  );
  displayTabs.openTab(payloadToTabSpec(payload), opts);
};

function MiniDisplayHomeTab() {
  return (
    <div className="chat-home-launcher">
      <ul className="chat-home-launcher__list">
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniCanvasDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="canvas" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Canvas</span>
              <span className="chat-home-launcher__entry-description">
                Pages Stella has put together
              </span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniMediaDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="media" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Media</span>
              <span className="chat-home-launcher__entry-description">
                Generated images, video, and audio
              </span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniTrashDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="trash" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Trash</span>
              <span className="chat-home-launcher__entry-description">
                Things you've recently deleted
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}

function openMiniHomeDisplayTab(opts?: MiniDisplayOpenOptions) {
  displayTabs.openTab(
    {
      id: MINI_HOME_DISPLAY_TAB_ID,
      kind: "home",
      title: "Home",
      tooltip: "Display sidebar home",
      render: () => <MiniDisplayHomeTab />,
    },
    opts,
  );
}

async function openMiniCanvasDisplayTab() {
  const [{ CanvasTabContent }, { getCanvasHtmlItems }] = await Promise.all([
    import("../shell/display/canvas-tab/CanvasTabContent"),
    import("../shell/display/canvas-tab/canvas-items"),
  ]);
  const items = getCanvasHtmlItems();
  displayTabs.openTab({
    id: "canvas:html",
    kind: "canvas",
    title: "Canvas",
    tooltip: "HTML canvases Stella has shown you",
    metadata: { kind: "canvas-html", items },
    render: () => <CanvasTabContent items={items} />,
  });
}

async function openMiniMediaDisplayTab() {
  const [{ MediaTabContent }, { getGeneratedMediaItems }] = await Promise.all([
    import("../shell/display/media-tab"),
    import("../shell/display/payload-to-tab-spec"),
  ]);
  const items = getGeneratedMediaItems();
  displayTabs.openTab({
    id: "media:generated",
    kind: "media",
    title: "Media",
    tooltip: "Generated media",
    metadata: { kind: "media", items },
    render: () => <MediaTabContent items={items} />,
  });
}

async function openMiniTrashDisplayTab() {
  const { TrashTabContent } = await import("../shell/display/TrashTabContent");
  displayTabs.openTab({
    id: "trash:deferred-delete",
    kind: "trash",
    title: "Trash",
    render: () => <TrashTabContent />,
  });
}

export function routeMiniDisplayPayload(
  rawPayload: unknown,
  opts?: MiniDisplayOpenOptions,
) {
  const payload = normalizeDisplayPayload(rawPayload);
  if (!payload) return;
  void openDisplayPayload(payload, opts);
}

export function openMiniWorkspacePanel(rawPayload?: unknown) {
  if (displayTabs.getSnapshot().tabs.length > 0) {
    displayTabs.setPanelOpen(true);
    return;
  }

  if (rawPayload != null) {
    routeMiniDisplayPayload(rawPayload);
    return;
  }

  openMiniHomeDisplayTab();
}

export function toggleMiniWorkspacePanel(rawPayload?: unknown) {
  if (displayTabs.getSnapshot().panelOpen) {
    displayTabs.setPanelOpen(false);
    return;
  }
  openMiniWorkspacePanel(rawPayload);
}

export function MiniDisplayTabBar() {
  const { tabs, activeTabId } = useDisplayTabList();
  const panelOpen = useDisplayPanelOpen();
  if (!panelOpen || tabs.length === 0) return null;

  return (
    <div className="mini-window-topbar__tabs" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const title = tab.id === MINI_HOME_DISPLAY_TAB_ID ? "Home" : tab.title;
        return (
          <div
            key={tab.id}
            className={`mini-display-tab${
              isActive ? " mini-display-tab--active" : ""
            }`}
            role="tab"
            aria-selected={isActive}
            title={tab.tooltip ?? title}
          >
            <button
              type="button"
              className="mini-display-tab__button"
              onClick={() => displayTabs.activateTab(tab.id)}
            >
              <DisplayTabIcon kind={tab.kind} size={18} />
              <span className="mini-display-tab__title">{title}</span>
            </button>
            <button
              type="button"
              className="mini-display-tab__close"
              aria-label={`Close ${title}`}
              onClick={(event) => {
                event.stopPropagation();
                displayTabs.closeTab(tab.id);
              }}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function MiniDisplayWorkspaceButton({
  latestRawPayloadRef,
}: {
  latestRawPayloadRef: RefObject<unknown | null>;
}) {
  const panelOpen = useDisplayPanelOpen();

  return (
    <button
      type="button"
      className="mini-window-topbar__button"
      onClick={() => toggleMiniWorkspacePanel(latestRawPayloadRef.current)}
      aria-label={panelOpen ? "Close workspace panel" : "Open workspace panel"}
      title={panelOpen ? "Close workspace panel" : "Open workspace panel"}
    >
      {panelOpen ? (
        <X size={15} strokeWidth={1.85} />
      ) : (
        <PanelRight size={14} strokeWidth={1.75} />
      )}
    </button>
  );
}

export function MiniDisplayPanelHost({
  portalTarget,
}: {
  portalTarget: HTMLDivElement | null;
}) {
  const panelOpen = useDisplayPanelOpen();

  useLayoutEffect(() => {
    if (panelOpen) {
      document.documentElement.dataset.displayPanelOpen = "true";
      if (portalTarget) portalTarget.dataset.displayPanelOpen = "true";
      return;
    }
    delete document.documentElement.dataset.displayPanelOpen;
    if (portalTarget) delete portalTarget.dataset.displayPanelOpen;
    return () => {
      delete document.documentElement.dataset.displayPanelOpen;
      if (portalTarget) delete portalTarget.dataset.displayPanelOpen;
    };
  }, [panelOpen, portalTarget]);

  if (!panelOpen) return null;

  return (
    <Suspense fallback={null}>
      <LazyRightSidebar portalTarget={portalTarget} />
    </Suspense>
  );
}
