import type { ChatContext } from "@/shared/types/electron";

/** Set when onboarding finishes; the root chrome consumes to open the sidebar chat once. */
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
export const STELLA_OPEN_DISPLAY_SIDEBAR_EVENT = "stella:open-display-sidebar";
export const STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT = "stella:close-display-sidebar";

export type StellaOpenSidebarChatDetail = {
  chatContext?: ChatContext | null;
  /** Optional text to prefill in the sidebar composer (e.g. a clicked suggestion). */
  prefillText?: string;
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

export function dispatchOpenDisplaySidebar() {
  window.dispatchEvent(new CustomEvent(STELLA_OPEN_DISPLAY_SIDEBAR_EVENT));
}

export function dispatchCloseDisplaySidebar() {
  window.dispatchEvent(new CustomEvent(STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT));
}

export const STELLA_SHOW_HOME_EVENT = "stella:show-home";

export function dispatchShowHome() {
  window.dispatchEvent(new CustomEvent(STELLA_SHOW_HOME_EVENT));
}
