import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { MOBILE_BRIDGE_FEATURES } from "../services/mobile-bridge/capabilities.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";

export const IPC_MOBILE_HELLO = "mobile:hello" as const;

type MobileHelloHandlersOptions = {
  localChatHistoryService: LocalChatHistoryService;
  /** Active conversation id from renderer UI state (may be empty pre-boot). */
  getActiveConversationId: () => string | null | undefined;
  /** Renderer localStorage mirror (ui-state KV snapshot). */
  getUiStateSnapshot: () => Record<string, string>;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export type MobileHelloPayload = {
  expectedConversationId?: string | null;
  sinceCursor?: string | null;
  maxMessages?: number;
  negotiateOnly?: boolean;
};

export const runMobileHello = async (
  options: Pick<
    MobileHelloHandlersOptions,
    "localChatHistoryService" | "getActiveConversationId" | "getUiStateSnapshot"
  >,
  payload?: MobileHelloPayload,
) => {
  const activeConversationId = (options.getActiveConversationId() ?? "").trim();
  const conversationId =
    activeConversationId ||
    (await options.localChatHistoryService.getOrCreateDefaultConversationId());

  const developerArtifactsEnabled =
    options.getUiStateSnapshot()[DEVELOPER_RESOURCE_PREVIEWS_KEY] === "true";
  const expected = payload?.expectedConversationId?.trim() || null;
  const conversationChanged = Boolean(expected && expected !== conversationId);
  const sinceCursor = conversationChanged
    ? null
    : (payload?.sinceCursor ?? null);
  const sync =
    payload?.negotiateOnly === true
      ? { messages: [], cursor: sinceCursor }
      : options.localChatHistoryService.syncMessages({
          conversationId,
          sinceCursor,
          maxMessages: payload?.maxMessages,
          includeDeveloperArtifacts: developerArtifactsEnabled,
        });

  return {
    conversationId,
    conversationChanged,
    developerArtifactsEnabled,
    features: [...MOBILE_BRIDGE_FEATURES],
    ...sync,
  };
};

/**
 * One-RTT connect endpoint for the mobile bridge. Folds what used to take
 * four serialized round-trips from the phone — `/bridge/bootstrap` (developer
 * artifacts flag), `ui:getState` (conversation id),
 * `localChat:getOrCreateDefaultConversationId` (fallback id) and
 * `localChat:syncMessages` (delta) — into a single invoke, and advertises the
 * desktop's optional bridge features so the phone can gate the binary lane,
 * envelope compression and localChat push.
 *
 * Additive: phones that predate it keep the multi-RTT path; phones that call
 * it against an older desktop get "Unknown IPC channel"/"Disallowed IPC
 * channel" and fall back.
 */
export const registerMobileHelloHandlers = (
  options: MobileHelloHandlersOptions,
) => {
  ipcMain.handle(
    IPC_MOBILE_HELLO,
    async (event, payload?: MobileHelloPayload) => {
      assertPrivilegedRequest(options, event, IPC_MOBILE_HELLO);
      return runMobileHello(options, payload);
    },
  );
};
