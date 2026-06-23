import { useEffect, type RefObject } from "react";
import {
  STELLA_CLOSE_PANEL_EVENT,
  STELLA_OPEN_WORKSPACE_PANEL_EVENT,
  STELLA_OPEN_PANEL_CHAT_EVENT,
  type StellaOpenPanelChatDetail,
} from "@/shared/lib/stella-orb-chat";
import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
import type { RightSidebarHandle } from "@/shell/RightSidebar";
import { displayTabs } from "@/features/workspace-display/tab-store";

type UseWorkspacePanelEventsOptions = {
  rightSidebarRef: RefObject<RightSidebarHandle | null>;
  latestDisplayPayloadRef: RefObject<DisplayTabPayload | null>;
  openChatPanel: (detail?: StellaOpenPanelChatDetail) => void;
  /**
   * Route-aware default surface for a manual panel summon (right-click /
   * keyboard). Opens the Home launcher on home and the chat viewer
   * elsewhere; reopens an already-active artifact viewer as-is.
   */
  openDefaultPanelSurface: () => void;
};

/**
 * Window-event + IPC wiring for the workspace panel. Subscribes to:
 * - `STELLA_OPEN_PANEL_CHAT_EVENT` — open the chat tab
 * - `STELLA_CLOSE_PANEL_EVENT` — close the panel
 * - `STELLA_OPEN_WORKSPACE_PANEL_EVENT` — manual summon; opens the
 *   route-aware default surface (Home launcher on home, chat elsewhere).
 * - `electronAPI.ui.onOpenChatSidebar` — IPC equivalent of "open chat tab".
 */
export function useWorkspacePanelEvents({
  rightSidebarRef,
  latestDisplayPayloadRef,
  openChatPanel,
  openDefaultPanelSurface,
}: UseWorkspacePanelEventsOptions): void {
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenPanelChatDetail>).detail;
      openChatPanel(detail ?? {});
    };

    const handleClose = () => displayTabs.setPanelOpen(false);

    const handleOpenDisplay = () => {
      openDefaultPanelSurface();
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
  }, [
    rightSidebarRef,
    latestDisplayPayloadRef,
    openChatPanel,
    openDefaultPanelSurface,
  ]);
}
