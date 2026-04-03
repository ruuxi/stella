import type { ChatContext } from "@/shared/types/electron";

/** Set when onboarding finishes; FullShellRuntime consumes to open the sidebar chat once. */
const OPEN_ORB_AFTER_ONBOARDING_KEY = "stella-open-orb-after-onboarding";

export function markOpenOrbAfterOnboarding(): void {
  try {
    sessionStorage.setItem(OPEN_ORB_AFTER_ONBOARDING_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function consumeOpenOrbAfterOnboarding(): boolean {
  try {
    if (sessionStorage.getItem(OPEN_ORB_AFTER_ONBOARDING_KEY) === "1") {
      sessionStorage.removeItem(OPEN_ORB_AFTER_ONBOARDING_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export const STELLA_OPEN_SIDEBAR_CHAT_EVENT = "stella:open-sidebar-chat";
export const STELLA_CLOSE_SIDEBAR_CHAT_EVENT = "stella:close-sidebar-chat";

export type StellaOpenSidebarChatDetail = {
  chatContext?: ChatContext | null;
};

export function dispatchOpenSidebarChat(detail: StellaOpenSidebarChatDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<StellaOpenSidebarChatDetail>(STELLA_OPEN_SIDEBAR_CHAT_EVENT, {
      detail,
    }),
  );
}

export function dispatchCloseSidebarChat() {
  window.dispatchEvent(new CustomEvent(STELLA_CLOSE_SIDEBAR_CHAT_EVENT));
}
