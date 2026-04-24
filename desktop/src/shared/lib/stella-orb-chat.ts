import type { ChatContext } from "@/shared/types/electron";

/**
 * Set when the user opted into Live Memory during onboarding but isn't
 * signed in yet. The post-onboarding root chrome consumes this once and
 * opens the AuthDialog so the user can finish signing in. After sign-in,
 * `memory.promotePending()` is called to actually enable the daemon.
 *
 * Persisted in `localStorage` (not `sessionStorage`) because the user may
 * close the app before signing in, and we want to re-prompt on next
 * launch rather than silently dropping the intent.
 */
const REQUEST_SIGN_IN_AFTER_ONBOARDING_KEY =
  "stella-request-signin-after-onboarding";

export function markRequestSignInAfterOnboarding(): void {
  try {
    localStorage.setItem(REQUEST_SIGN_IN_AFTER_ONBOARDING_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function consumeRequestSignInAfterOnboarding(): boolean {
  try {
    if (localStorage.getItem(REQUEST_SIGN_IN_AFTER_ONBOARDING_KEY) === "1") {
      localStorage.removeItem(REQUEST_SIGN_IN_AFTER_ONBOARDING_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function clearRequestSignInAfterOnboarding(): void {
  try {
    localStorage.removeItem(REQUEST_SIGN_IN_AFTER_ONBOARDING_KEY);
  } catch {
    /* ignore */
  }
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
