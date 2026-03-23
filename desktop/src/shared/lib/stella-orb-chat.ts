import type { ChatContext } from "@/shared/types/electron";

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
