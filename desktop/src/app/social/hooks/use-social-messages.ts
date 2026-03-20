import { useCallback, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";

export function useSocialMessages(roomId: string) {
  const messages = useQuery(api.social.messages.listRoomMessages, {
    roomId,
    limit: 50,
  });

  const sendMutation = useMutation(api.social.messages.sendRoomMessage);
  const clientIdRef = useRef(0);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      clientIdRef.current += 1;
      const clientMessageId = `local-${Date.now()}-${clientIdRef.current}`;
      await sendMutation({ roomId, body: trimmed, clientMessageId });
    },
    [roomId, sendMutation],
  );

  return {
    messages: messages ?? [],
    sendMessage,
  };
}
