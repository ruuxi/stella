import { useEffect, type RefObject } from "react";
import {
  STELLA_CLOSE_PANEL_EVENT,
  STELLA_OPEN_WORKSPACE_PANEL_EVENT,
  STELLA_OPEN_PANEL_CHAT_EVENT,
  type StellaOpenPanelChatDetail,
} from "@/shared/lib/stella-orb-chat";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { DisplaySidebarHandle } from "@/shell/DisplaySidebar";
import { displayTabs } from "@/shell/display/tab-store";

type UseWorkspacePanelEventsOptions = {
  displaySidebarRef: RefObject<DisplaySidebarHandle | null>;
  latestDisplayPayloadRef: RefObject<DisplayPayload | null>;
  openChatPanel: (detail?: StellaOpenPanelChatDetail) => void;
};

/**
 * Window-event + IPC wiring for the workspace panel. Subscribes to:
 * - `STELLA_OPEN_PANEL_CHAT_EVENT` — open the chat tab
 * - `STELLA_CLOSE_PANEL_EVENT` — close the panel
 * - `STELLA_OPEN_WORKSPACE_PANEL_EVENT` — show whatever's already open,
 *   or fall back to the last display payload, or seed the chat tab.
 * - `electronAPI.ui.onOpenChatSidebar` — IPC equivalent of "open chat tab".
 */
export function useWorkspacePanelEvents({
  displaySidebarRef,
  latestDisplayPayloadRef,
  openChatPanel,
}: UseWorkspacePanelEventsOptions): void {
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenPanelChatDetail>).detail;
      openChatPanel(detail ?? {});
    };

    const handleClose = () => displayTabs.setPanelOpen(false);

    const handleOpenDisplay = () => {
      // Prefer reopening whatever tabs are already in the manager; only
      // fall back to re-routing the last payload when nothing has been
      // opened yet this session. If there is no display payload yet,
      // seed the panel with Chat so the workspace panel is always
      // openable.
      if (displayTabs.getSnapshot().tabs.length > 0) {
        displayTabs.setPanelOpen(true);
        return;
      }
      const payload = latestDisplayPayloadRef.current;
      if (!payload) {
        openChatPanel();
        return;
      }
      displaySidebarRef.current?.open(payload);
    };

    window.addEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
    window.addEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
    window.addEventListener(
      STELLA_OPEN_WORKSPACE_PANEL_EVENT,
      handleOpenDisplay,
    );

    const cleanupIpcOpen = window.electronAPI?.ui.onOpenChatSidebar?.(() => {
      openChatPanel();
    });

    return () => {
      window.removeEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
      window.removeEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
      window.removeEventListener(
        STELLA_OPEN_WORKSPACE_PANEL_EVENT,
        handleOpenDisplay,
      );
      cleanupIpcOpen?.();
    };
  }, [displaySidebarRef, latestDisplayPayloadRef, openChatPanel]);
}
