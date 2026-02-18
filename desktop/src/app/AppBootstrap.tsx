import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { configureLocalHost, getOrCreateDeviceId } from "../services/device";
import { isLocalMode, localPost } from "../services/local-client";

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const hostPromise = configureLocalHost();
      const devicePromise = getOrCreateDeviceId();

      if (isLocalMode()) {
        // Local mode: get/create default conversation from local server
        try {
          const conversation = await localPost<{ id: string }>(
            "/api/conversations/default",
            {},
          );
          if (!cancelled && conversation?.id) {
            setConversationId(conversation.id);
          }
        } catch (err) {
          console.error("[AppBootstrap] Local conversation setup failed:", err);
        }
      } else {
        // Cloud mode: use Convex mutation
        const conversation = await getOrCreateDefaultConversation({});
        if (!cancelled && conversation?._id) {
          setConversationId(conversation._id);
        }
      }

      await Promise.allSettled([hostPromise, devicePromise]);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [getOrCreateDefaultConversation, setConversationId]);

  return null;
};
