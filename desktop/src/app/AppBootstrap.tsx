import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { configureLocalHost, getOrCreateDeviceId } from "../services/device";
import { localPost, localGet } from "../services/local-client";
import { useIsLocalMode } from "@/providers/DataProvider";

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const isLocalMode = useIsLocalMode();
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

      if (isLocalMode) {
        // Local mode: get/create default conversation from local server
        try {
          const conversation = await localPost<{ id: string }>(
            "/api/conversations/default",
            {},
          );
          if (!cancelled && conversation?.id) {
            setConversationId(conversation.id);
          }
          const shortcutPref = await localGet<{ value?: string }>("/api/preferences/voice_shortcut").catch(() => null);
          if (shortcutPref?.value) {
            window.electronAPI?.setVoiceShortcut?.(shortcutPref.value);
          }
        } catch (err) {
          console.error("[AppBootstrap] Local conversation setup failed:", err);
          if (!cancelled) {
            setConversationId(null);
          }
        }
      } else if (isAuthenticated) {
        // Cloud mode: use Convex mutation
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
    isLocalMode,
    setConversationId,
  ]);

  return null;
};
