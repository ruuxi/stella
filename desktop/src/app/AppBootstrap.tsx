import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useUiState } from "./state/ui-state";
import { api } from "../convex/api";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";

export const AppBootstrap = () => {
  const { setConversationId } = useUiState();
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );

  useEffect(() => {
    getOrCreateDeviceId();
    void getOrCreateDefaultConversation({ ownerId: getOwnerId() }).then(
      (conversation: { _id?: string } | null) => {
        if (conversation?._id) {
          setConversationId(conversation._id);
        }
      },
    );
  }, [getOrCreateDefaultConversation, setConversationId]);

  return null;
};
