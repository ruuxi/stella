import type { OpenTabOptions } from "./types";

export const CHAT_DISPLAY_TAB_ID = "chat";
export const HOME_DISPLAY_TAB_ID = "home";
export const STORE_DISPLAY_TAB_ID = "store:side-panel";
export const TRASH_DISPLAY_TAB_ID = "trash:deferred-delete";

type WorkspaceDefaultTabsAdapter = {
  openChatDisplayTab: (openRequest?: unknown, opts?: OpenTabOptions) => void;
  openHomeDisplayTab: () => void;
  ensureChatDisplayTab: () => void;
  openStoreDisplayTab: () => void;
  openTrashDisplayTab: () => void;
  openEngineDisplayTab: () => void;
};

let adapter: WorkspaceDefaultTabsAdapter | null = null;

export const registerWorkspaceDefaultTabs = (
  nextAdapter: WorkspaceDefaultTabsAdapter,
): void => {
  adapter = nextAdapter;
};

const getAdapter = (): WorkspaceDefaultTabsAdapter => {
  if (!adapter) {
    throw new Error("Workspace default tabs adapter has not been registered.");
  }
  return adapter;
};

export function openChatDisplayTab(
  openRequest: unknown = null,
  opts?: OpenTabOptions,
): void {
  getAdapter().openChatDisplayTab(openRequest, opts);
}

export function openHomeDisplayTab(): void {
  getAdapter().openHomeDisplayTab();
}

export function ensureChatDisplayTab(): void {
  getAdapter().ensureChatDisplayTab();
}

export function openStoreDisplayTab(): void {
  getAdapter().openStoreDisplayTab();
}

export function openTrashDisplayTab(): void {
  getAdapter().openTrashDisplayTab();
}

export function openEngineDisplayTab(): void {
  getAdapter().openEngineDisplayTab();
}
