import { dispatchOpenPanelChat } from "@/shared/lib/stella-orb-chat";

export const STELLA_SEND_MESSAGE_EVENT = "stella:send-message";
export const WORKSPACE_CREATION_TRIGGER_KIND = "workspace_creation_request";

export type StellaSendMessageDetail = {
  text: string;
  uiVisibility?: "visible" | "hidden";
  triggerKind?: string;
  triggerSource?: string;
  targetAgentId?: string;
};

type StellaSendMessageOptions = {
  openPanel?: boolean;
};

export function toStellaMessageMetadata(
  detail: StellaSendMessageDetail,
): {
  ui?: { visibility?: "visible" | "hidden" };
  trigger?: { kind?: string; source?: string };
} | undefined {
  const uiVisibility = detail.uiVisibility;
  const triggerKind = detail.triggerKind?.trim();
  const triggerSource = detail.triggerSource?.trim();
  const targetAgentId = detail.targetAgentId?.trim();

  if (!uiVisibility && !triggerKind && !triggerSource && !targetAgentId) {
    return undefined;
  }

  return {
    ...(uiVisibility ? { ui: { visibility: uiVisibility } } : {}),
    ...((triggerKind || triggerSource)
      ? {
          trigger: {
            ...(triggerKind ? { kind: triggerKind } : {}),
            ...(triggerSource ? { source: triggerSource } : {}),
            ...(targetAgentId ? { targetAgentId } : {}),
          },
        }
      : {}),
  };
}

export function dispatchStellaSendMessage(
  detail: StellaSendMessageDetail,
  options: StellaSendMessageOptions = {},
) {
  // Ensure the panel chat is open so the user sees the response, unless the
  // caller is already routing the user to a chat surface.
  if (options.openPanel !== false) {
    dispatchOpenPanelChat();
  }
  window.dispatchEvent(
    new CustomEvent<StellaSendMessageDetail>(STELLA_SEND_MESSAGE_EVENT, {
      detail,
    }),
  );
}
