import type { ChatContext } from "@/shared/types/electron";

/** Set when onboarding finishes; FullShellRuntime consumes to open the orb once. */
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

export const STELLA_OPEN_ORB_CHAT_EVENT = "stella:open-orb-chat";
export const STELLA_CLOSE_ORB_CHAT_EVENT = "stella:close-orb-chat";

export type StellaOpenOrbChatDetail = {
  chatContext?: ChatContext | null;
};

export function dispatchOpenOrbChat(detail: StellaOpenOrbChatDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<StellaOpenOrbChatDetail>(STELLA_OPEN_ORB_CHAT_EVENT, {
      detail,
    }),
  );
}

export function dispatchCloseOrbChat() {
  window.dispatchEvent(new CustomEvent(STELLA_CLOSE_ORB_CHAT_EVENT));
}
