import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { configureLocalHost, getOrCreateDeviceId } from "../services/device";

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const { isAuthenticated } = useConvexAuth();
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const hostPromise = configureLocalHost();
      const devicePromise = getOrCreateDeviceId();
      setConversationId(null);

      if (isAuthenticated) {
        try {
          const conversation = await getOrCreateDefaultConversation({});
          if (!cancelled && conversation?._id) {
            setConversationId(conversation._id);
          }
          const savedShortcut = localStorage.getItem("stella-voice-shortcut");
          if (savedShortcut) {
            window.electronAPI?.setVoiceShortcut?.(savedShortcut);
          }
        } catch (err) {
          console.error("[AppBootstrap] Cloud conversation setup failed:", err);
          if (!cancelled) {
            setConversationId(null);
          }
        }
      }

      await Promise.allSettled([hostPromise, devicePromise]);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    getOrCreateDefaultConversation,
    isAuthenticated,
    setConversationId,
  ]);

  return null;
};
