import { createElement } from "react";
import { ChatPanelTab, type ChatPanelOpenRequest } from "@/shell/ChatSidebar";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { StoreSidePanel } from "@/features/store/StoreSidePanel";
import { TrashTabContent } from "./TrashTabContent";
import { HomeLauncherTab } from "./HomeLauncherTab";
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
 * Chat display tab body — the live in-panel chat, available from any route
 * so users can keep talking to Stella while a viewer is open. (The home
 * index now lives in the left `WorkspaceSidebar`, not here.)
 */
function ChatDisplayTab({
  openRequest,
}: {
  openRequest: ChatPanelOpenRequest | null;
}) {
  const panelExpanded = useDisplayPanelExpanded();
  const chat = useChatRuntime();

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
      activeToolCallId={chat.conversation.streaming.activeToolCallId}
      activeToolName={chat.conversation.streaming.activeToolName}
      hasToolActivity={chat.conversation.streaming.hasToolActivity}
      isToolActive={chat.conversation.streaming.isToolActive}
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

/**
 * Open the Home launcher tab — the quiet launcher of other display
 * surfaces (Canvas / Media / Trash) shown when the user summons the panel
 * while on home. Home itself is the chat, so the panel never opens to a
 * duplicate chat there.
 */
export function openHomeDisplayTab(): void {
  displayTabs.openTab({
    id: HOME_DISPLAY_TAB_ID,
    kind: "home",
    title: "Home",
    tooltip: "Jump into Canvas, Media, Store, and more",
    render: () => createElement(HomeLauncherTab),
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
 * Open the sidebar Models popover. Callers that navigate to `/chat`
 * first continue to work — we activate the Chat display tab and open
 * the popover anchored to the footer Models button.
 */
export function openEngineDisplayTab(): void {
  openChatDisplayTab(null);
  engineOverlay.setOpen(true);
}

export function openMediaDisplayTab(selectedItemId?: string): void {
  const items = getGeneratedMediaItems();
  displayTabs.openTab({
    id: MEDIA_DISPLAY_TAB_ID,
    kind: "media",
    title: "Media",
    tooltip: "Generated media",
    metadata: { kind: "media", items },
    render: () =>
      createElement(MediaTabContent, {
        items,
        ...(selectedItemId ? { selectedItemId } : {}),
      }),
  });
}

export function openCanvasDisplayTab(selectedItemId?: string): void {
  const items = getCanvasHtmlItems();
  displayTabs.openTab({
    id: CANVAS_DISPLAY_TAB_ID,
    kind: "canvas",
    title: "Canvas",
    tooltip: "HTML canvases Stella has shown you",
    metadata: { kind: "canvas-html", items },
    render: () =>
      createElement(CanvasTabContent, {
        items,
        ...(selectedItemId ? { selectedItemId } : {}),
      }),
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
