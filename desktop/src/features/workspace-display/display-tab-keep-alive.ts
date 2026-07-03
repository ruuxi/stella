/**
 * Keep-alive policy for the display panel's active tab across close/open.
 *
 * Canvas tabs host a sandboxed `srcdoc` iframe: unmounting it on panel close
 * destroys the browsing context, so every reopen used to re-parse the
 * document, re-execute its scripts, refetch CDN assets, and lose all
 * scroll/interaction state — the visible "lag" when toggling the panel with
 * a canvas loaded. Keeping the rendered canvas mounted (hidden with
 * `display: none`, which preserves an iframe's browsing context as long as
 * the element stays in the DOM) makes reopen instant and stateful.
 *
 * Scope is deliberately canvas-only: other tab kinds (media, chat, PDF …)
 * keep the unmount-on-close lifecycle so e.g. a playing video still stops
 * when the panel closes. Memory stays bounded because the canvas tab mounts
 * at most one iframe (the selected item), and only the most recently
 * rendered tab is ever kept.
 */

import type { DisplayTabSpec } from "./types";

export type DisplayTabKeepAliveResult = {
  /** Tab content to render right now (visible when open, hidden keep-alive
   *  host when closed). `null` renders nothing. */
  renderedTab: DisplayTabSpec | null;
  /** Id of the tab whose content is mounted after this render; feed it back
   *  on the next call. */
  lastRenderedTabId: string | null;
};

const isKeepAliveTabKind = (tab: DisplayTabSpec): boolean =>
  tab.kind === "canvas";

export function resolveDisplayTabKeepAlive({
  panelOpen,
  activeTab,
  lastRenderedTabId,
}: {
  panelOpen: boolean;
  activeTab: DisplayTabSpec | null;
  /** Id of the tab that was mounted on the previous render (or null). */
  lastRenderedTabId: string | null;
}): DisplayTabKeepAliveResult {
  if (panelOpen) {
    return activeTab
      ? { renderedTab: activeTab, lastRenderedTabId: activeTab.id }
      : { renderedTab: null, lastRenderedTabId: null };
  }

  // Panel closed: keep the content alive only if it is the SAME tab the
  // user was just looking at and it is a keep-alive kind. If the active tab
  // was replaced while closed (e.g. a payload update activated another
  // viewer), drop the kept content — the next open renders fresh, exactly
  // like the pre-keep-alive lifecycle.
  const kept =
    activeTab !== null &&
    activeTab.id === lastRenderedTabId &&
    isKeepAliveTabKind(activeTab)
      ? activeTab
      : null;

  return {
    renderedTab: kept,
    lastRenderedTabId: kept ? kept.id : null,
  };
}
