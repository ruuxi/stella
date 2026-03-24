export const STELLA_SEND_MESSAGE_EVENT = "stella:send-message";
export const WORKSPACE_CREATION_TRIGGER_KIND = "workspace_creation_request";

export type StellaSendMessageDetail = {
  text: string;
  uiVisibility?: "visible" | "hidden";
  triggerKind?: string;
  triggerSource?: string;
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

  if (!uiVisibility && !triggerKind && !triggerSource) {
    return undefined;
  }

  return {
    ...(uiVisibility ? { ui: { visibility: uiVisibility } } : {}),
    ...((triggerKind || triggerSource)
      ? {
          trigger: {
            ...(triggerKind ? { kind: triggerKind } : {}),
            ...(triggerSource ? { source: triggerSource } : {}),
          },
        }
      : {}),
  };
}

export function dispatchStellaSendMessage(detail: StellaSendMessageDetail) {
  // Ensure the orb chat is open so the user sees the response
  window.dispatchEvent(
    new CustomEvent("stella:open-orb-chat", { detail: {} }),
  );
  window.dispatchEvent(
    new CustomEvent<StellaSendMessageDetail>(STELLA_SEND_MESSAGE_EVENT, {
      detail,
    }),
  );
}
