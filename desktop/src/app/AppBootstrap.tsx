import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { useAccountMode } from "../hooks/use-account-mode";
import { configureLocalHost, getOrCreateDeviceId } from "../services/device";
import {
  buildLocalSyncMessages,
  getLocalSyncCheckpoint,
  getOrCreateLocalConversationId,
  setLocalSyncCheckpoint,
  type LocalSyncMessage,
} from "../services/local-chat-store";

const LOCAL_SYNC_CHUNK_SIZE = 100;

const getUnsyncedMessages = (
  messages: LocalSyncMessage[],
  checkpoint: string | null,
): LocalSyncMessage[] => {
  if (!checkpoint) return messages;
  const checkpointIndex = messages.findIndex((message) => message.localMessageId === checkpoint);
  if (checkpointIndex < 0) return messages;
  return messages.slice(checkpointIndex + 1);
};

const chunkMessages = (
  messages: LocalSyncMessage[],
  chunkSize = LOCAL_SYNC_CHUNK_SIZE,
): LocalSyncMessage[][] => {
  if (messages.length === 0) return [];
  const chunks: LocalSyncMessage[][] = [];
  for (let start = 0; start < messages.length; start += chunkSize) {
    chunks.push(messages.slice(start, start + chunkSize));
  }
  return chunks;
};

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const { isAuthenticated } = useConvexAuth();
  const accountMode = useAccountMode();
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );
  const importLocalMessagesChunk = useMutation(
    api.events.importLocalMessagesChunk,
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const hostPromise = configureLocalHost();
      const devicePromise = getOrCreateDeviceId();

      if (!isAuthenticated) {
        if (!cancelled) {
          setConversationId(getOrCreateLocalConversationId());
        }
        await Promise.allSettled([hostPromise, devicePromise]);
        return;
      }

      if (accountMode === undefined) {
        await Promise.allSettled([hostPromise, devicePromise]);
        return;
      }

      if (accountMode === "private_local") {
        if (!cancelled) {
          setConversationId(getOrCreateLocalConversationId());
        }
        await Promise.allSettled([hostPromise, devicePromise]);
        return;
      }

      try {
        const conversation = await getOrCreateDefaultConversation({});
        if (!cancelled && conversation?._id) {
          const localConversationId = getOrCreateLocalConversationId();
          const localMessages = buildLocalSyncMessages(localConversationId);
          const checkpoint = getLocalSyncCheckpoint(localConversationId);
          const unsyncedMessages = getUnsyncedMessages(localMessages, checkpoint);

          if (unsyncedMessages.length > 0) {
            try {
              const chunks = chunkMessages(unsyncedMessages);
              for (const chunk of chunks) {
                if (cancelled) {
                  break;
                }
                await importLocalMessagesChunk({
                  conversationId: conversation._id as never,
                  messages: chunk,
                });
              }
              const lastSyncedMessage = unsyncedMessages[unsyncedMessages.length - 1];
              if (!cancelled && lastSyncedMessage) {
                setLocalSyncCheckpoint(localConversationId, lastSyncedMessage.localMessageId);
              }
            } catch (syncError) {
              console.error("[AppBootstrap] Local message sync failed:", syncError);
            }
          }

          if (!cancelled) {
            setConversationId(conversation._id);
          }
        }
        const savedShortcut = localStorage.getItem("stella-voice-shortcut");
        if (savedShortcut) {
          window.electronAPI?.setVoiceShortcut(savedShortcut);
        }
      } catch (err) {
        console.error("[AppBootstrap] Cloud conversation setup failed:", err);
      }

      await Promise.allSettled([hostPromise, devicePromise]);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    getOrCreateDefaultConversation,
    importLocalMessagesChunk,
    accountMode,
    isAuthenticated,
    setConversationId,
  ]);

  return null;
};
