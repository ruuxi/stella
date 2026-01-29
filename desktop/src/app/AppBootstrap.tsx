import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { configureLocalHost, getOrCreateDeviceId } from "../services/device";

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await configureLocalHost();
      await getOrCreateDeviceId();
      const conversation = await getOrCreateDefaultConversation({});
      if (!cancelled && conversation?._id) {
        setConversationId(conversation._id);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [getOrCreateDefaultConversation, setConversationId]);

  return null;
};
