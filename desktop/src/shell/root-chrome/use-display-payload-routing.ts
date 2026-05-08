import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useMediaMaterializer } from "@/app/media/use-media-materializer";
import {
  type DisplayTabPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import type { DisplaySidebarHandle } from "@/shell/DisplaySidebar";

type UseDisplayPayloadRoutingOptions = {
  displaySidebarRef: RefObject<DisplaySidebarHandle | null>;
  isMiniWindow: boolean;
  isOnChatRoute: boolean;
  showHomeContent: boolean;
};

type UseDisplayPayloadRoutingResult = {
  routeDisplayPayload: (payload: DisplayTabPayload) => void;
  /**
   * The most recently routed payload, kept around so the workspace
   * panel can fall back to it when the user manually summons the
   * panel without an active payload (see `useWorkspacePanelEvents`).
   */
  latestDisplayPayloadRef: RefObject<DisplayTabPayload | null>;
};

/**
 * Push payloads into the workspace panel.
 *
 * - `media`, `url`, and `trash` payloads always open the panel
 *   (generated artifacts and live previews are the user's main goal in
 *   that moment).
 * - For everything else (office / pdf / markdown / source-diff), keep
 *   the existing behavior: open on the chat home pane, hot-update
 *   elsewhere so we don't steal focus mid-conversation.
 * - In the mini window, register payloads passively (`ds.update`) and
 *   let the user summon the panel via the right-click context menu.
 *
 * Also seeds the workspace panel with a stable Trash tab when the
 * previous agent run left files in deferred-delete trash, and wires
 * the owner-scoped media materializer so any media job gets surfaced
 * here too.
 */
export function useDisplayPayloadRouting({
  displaySidebarRef,
  isMiniWindow,
  isOnChatRoute,
  showHomeContent,
}: UseDisplayPayloadRoutingOptions): UseDisplayPayloadRoutingResult {
  const latestDisplayPayloadRef = useRef<DisplayTabPayload | null>(null);

  const routeDisplayPayload = useCallback(
    (payload: DisplayTabPayload) => {
      latestDisplayPayloadRef.current = payload;
      const ds = displaySidebarRef.current;
      if (!ds) return;
      if (isMiniWindow) {
        ds.update(payload);
        return;
      }
      if (
        payload.kind === "media" ||
        payload.kind === "canvas-html" ||
        payload.kind === "url" ||
        payload.kind === "trash"
      ) {
        ds.open(payload);
        return;
      }
      if (showHomeContent && isOnChatRoute) {
        ds.open(payload);
      } else {
        ds.update(payload);
      }
    },
    [displaySidebarRef, isMiniWindow, isOnChatRoute, showHomeContent],
  );

  // Structured display payloads from main process.
  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      const payload = normalizeDisplayPayload(rawPayload);
      if (!payload) return;
      routeDisplayPayload(payload);
    });
  }, [routeDisplayPayload]);

  // If the previous agent run left files in deferred-delete trash, seed
  // the workspace panel with a stable tab without opening UI. The
  // actual Trash tab UI is intentionally deferred; this just wires
  // discovery and tab routing.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.display
      ?.listTrash?.()
      ?.then((result: { items?: unknown[] } | null) => {
        if (cancelled || !result || !Array.isArray(result.items)) return;
        if (result.items.length === 0) return;
        displaySidebarRef.current?.update({
          kind: "trash",
          title: "Trash",
          createdAt: Date.now(),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [displaySidebarRef]);

  // Owner-scoped materializer: any media job (this conversation,
  // another device, the agent, the studio, …) gets downloaded into
  // `state/media/outputs/` and surfaced in the workspace panel.
  useMediaMaterializer({ onMaterialized: routeDisplayPayload });

  return {
    routeDisplayPayload,
    latestDisplayPayloadRef,
  };
}
