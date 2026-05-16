import { createElement } from "react";
import { useMatchRoute } from "@tanstack/react-router";
import { ChatPanelTab, type ChatPanelOpenRequest } from "@/shell/ChatSidebar";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { StoreSidePanel } from "@/global/store/StoreSidePanel";
import { TrashTabContent } from "./TrashTabContent";
import { ChatHomeOverview } from "./ChatHomeOverview";
import { MediaTabContent } from "./tab-content";
import { CanvasTabContent } from "./canvas-tab/CanvasTabContent";
import { getCanvasHtmlItems } from "./canvas-tab/canvas-items";
import { displayTabs } from "./tab-store";
import {
  CANVAS_HTML_TAB_ID,
  GENERATED_MEDIA_TAB_ID,
  getGeneratedMediaItems,
} from "./payload-to-tab-spec";
import type { OpenTabOptions } from "./types";

export const CHAT_DISPLAY_TAB_ID = "chat";
export const STORE_DISPLAY_TAB_ID = "store:side-panel";
export const TRASH_DISPLAY_TAB_ID = "trash:deferred-delete";
export const MEDIA_DISPLAY_TAB_ID = GENERATED_MEDIA_TAB_ID;
export const CANVAS_DISPLAY_TAB_ID = CANVAS_HTML_TAB_ID;

/**
 * Chat display tab body. Always mounted via the singleton tab store; its
 * content adapts to the current route:
 *
 *   - On `/chat` (home): the home view IS the chat, so duplicating it in
 *     the panel adds no value. Show `ChatHomeOverview` instead — recent
 *     activity and changed files at a glance.
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
  const chat = useChatRuntime();

  if (isOnHomeChatRoute) return <ChatHomeOverview />;

  return (
    <ChatPanelTab
      openRequest={openRequest}
      messages={chat.conversation.messages}
      events={chat.conversation.events}
      streamingText={chat.conversation.streamingText}
      isStreaming={chat.conversation.isStreaming}
      runtimeStatusText={chat.conversation.streaming.runtimeStatusText}
      pendingUserMessageId={chat.conversation.pendingUserMessageId}
      queuedUserMessages={chat.conversation.streaming.queuedUserMessages}
      optimisticUserMessageIds={
        chat.conversation.streaming.optimisticUserMessageIds
      }
      liveTasks={chat.conversation.streaming.liveTasks}
      hasOlderMessages={chat.conversation.hasOlderMessages}
      isLoadingOlder={chat.conversation.isLoadingOlder}
      isInitialLoading={chat.conversation.isInitialLoading}
      onSend={chat.conversation.sendMessageWithContext}
      onStop={chat.conversation.cancelCurrentStream}
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
