import { createElement } from "react";
import { useMatchRoute } from "@tanstack/react-router";
import { ChatPanelTab, type ChatPanelOpenRequest } from "@/shell/ChatSidebar";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { StoreSidePanel } from "@/features/store/StoreSidePanel";
import { TrashTabContent } from "./TrashTabContent";
import { ChatHomeOverview } from "./ChatHomeOverview";
import { MediaTabContent } from "./tab-content";
import { CanvasTabContent } from "./canvas-tab/CanvasTabContent";
import { getCanvasHtmlItems } from "./canvas-tab/canvas-items";
import { displayTabs, useDisplayPanelExpanded } from "@/features/workspace-display/tab-store";
import { engineOverlay } from "./engine-overlay-store";
import {
  CANVAS_DISPLAY_TAB_ID,
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  MEDIA_DISPLAY_TAB_ID,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
  registerWorkspaceDefaultTabs,
} from "@/features/workspace-display/default-tabs";
import { getGeneratedMediaItems } from "./payload-to-tab-spec";
import type { OpenTabOptions } from "@/features/workspace-display/types";

export {
  CANVAS_DISPLAY_TAB_ID,
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  MEDIA_DISPLAY_TAB_ID,
  STORE_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
} from "@/features/workspace-display/default-tabs";

/**
 * Chat display tab body. Always mounted via the singleton tab store; its
 * content adapts to the current route:
 *
 *   - On `/chat` (home): the normal side panel shows `ChatHomeOverview`
 *     instead of duplicating the main chat. Expanded mode takes over the
 *     main outlet, so it renders the live chat there too.
 *   - Everywhere else: render the live `ChatPanelTab` so users can keep
 *     talking to Stella from any route.
 *
 * Switching here keeps the tab's identity and selection stable across
 * navigation; the route never closes / reopens / re-selects the tab.
 */
function ChatDisplayTab({
  openRequest,
}: {
  openRequest: ChatPanelOpenRequest | null;
}) {
  const matchRoute = useMatchRoute();
  const isOnHomeChatRoute = Boolean(matchRoute({ to: "/chat" }));
  const panelExpanded = useDisplayPanelExpanded();
  const chat = useChatRuntime();

  if (isOnHomeChatRoute && !panelExpanded) return <ChatHomeOverview />;

  return (
    <ChatPanelTab
      openRequest={openRequest}
      wideLayout={panelExpanded}
      messages={chat.conversation.messages}
      activities={chat.conversation.activity.activities}
      latestMessageTimestampMs={
        chat.conversation.activity.latestMessageTimestampMs
      }
      isStreaming={chat.conversation.isStreaming}
      isStreamingResponseText={
        chat.conversation.streaming.isStreamingResponseText
      }
      runtimeStatusText={chat.conversation.streaming.runtimeStatusText}
      pendingUserMessageId={chat.conversation.pendingUserMessageId}
      queuedUserMessages={chat.conversation.streaming.queuedUserMessages}
      liveTasks={chat.conversation.streaming.liveTasks}
      hasOlderMessages={chat.conversation.hasOlderMessages}
      isLoadingOlder={chat.conversation.isLoadingOlder}
      isInitialLoading={chat.conversation.isInitialLoading}
      onLoadOlder={chat.conversation.loadOlderMessages}
      onSend={chat.conversation.sendMessageWithContext}
      onStop={chat.conversation.cancelCurrentStream}
      onNewChat={chat.conversation.startNewChat}
    />
  );
}

export function openChatDisplayTab(
  openRequest: ChatPanelOpenRequest | null = null,
  opts?: OpenTabOptions,
): void {
  displayTabs.openTab(
    {
      id: CHAT_DISPLAY_TAB_ID,
      kind: "chat",
      title: "Chat",
      render: () => createElement(ChatDisplayTab, { openRequest }),
    },
    opts,
  );
}

export function openHomeDisplayTab(): void {
  displayTabs.openTab({
    id: HOME_DISPLAY_TAB_ID,
    kind: "home",
    title: "Home",
    tooltip: "Display sidebar home",
    render: () => createElement(ChatHomeOverview),
  });
}

/**
 * Ensure the Chat tab is registered. The tab is always present so users
 * can switch to it from any route — content adapts inside `ChatDisplayTab`
 * based on the active route. This is a passive register: it never steals
 * activation from the user's current selection or opens the panel.
 */
export function ensureChatDisplayTab(): void {
  openChatDisplayTab(null, { activate: false, openPanel: false });
}

export function openStoreDisplayTab(): void {
  displayTabs.openTab({
    id: STORE_DISPLAY_TAB_ID,
    kind: "store",
    title: "Store",
    tooltip: "Your add-ons + recent changes",
    render: () => createElement(StoreSidePanel),
  });
}

export function openTrashDisplayTab(): void {
  displayTabs.openTab({
    id: TRASH_DISPLAY_TAB_ID,
    kind: "trash",
    title: "Trash",
    render: () => createElement(TrashTabContent),
  });
}

/**
 * Open the engine / models surface. It now lives as an inline overlay
 * at the bottom of the Chat home overview, not as its own display tab.
 * Callers that previously navigated to `/chat` before invoking this
 * function continue to work — we just activate the Chat display tab
 * and flip the overlay on.
 */
export function openEngineDisplayTab(): void {
  openChatDisplayTab(null);
  engineOverlay.setOpen(true);
}

export function openMediaDisplayTab(): void {
  const items = getGeneratedMediaItems();
  displayTabs.openTab({
    id: MEDIA_DISPLAY_TAB_ID,
    kind: "media",
    title: "Media",
    tooltip: "Generated media",
    metadata: { kind: "media", items },
    render: () => createElement(MediaTabContent, { items }),
  });
}

export function openCanvasDisplayTab(): void {
  const items = getCanvasHtmlItems();
  displayTabs.openTab({
    id: CANVAS_DISPLAY_TAB_ID,
    kind: "canvas",
    title: "Canvas",
    tooltip: "HTML canvases Stella has shown you",
    metadata: { kind: "canvas-html", items },
    render: () => createElement(CanvasTabContent, { items }),
  });
}

registerWorkspaceDefaultTabs({
  openChatDisplayTab: (openRequest, opts) =>
    openChatDisplayTab(openRequest as ChatPanelOpenRequest | null, opts),
  openHomeDisplayTab,
  ensureChatDisplayTab,
  openStoreDisplayTab,
  openTrashDisplayTab,
  openEngineDisplayTab,
  openMediaDisplayTab,
  openCanvasDisplayTab,
});
