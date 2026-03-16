import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useCallback, useRef } from "react";

export function useSocialMessages(roomId: string | null) {
  const messages = useQuery(
    api.social.messages.listRoomMessages,
    roomId ? { roomId, limit: 50 } : "skip",
  );

  const sendMutation = useMutation(api.social.messages.sendRoomMessage);
  const clientIdRef = useRef(0);

  const sendMessage = useCallback(
    async (body: string) => {
      if (!roomId || !body.trim()) return;
      clientIdRef.current += 1;
      const clientMessageId = `local-${Date.now()}-${clientIdRef.current}`;
      await sendMutation({ roomId, body: body.trim(), clientMessageId });
    },
    [roomId, sendMutation],
  );

  return {
    messages: messages ?? [],
    sendMessage,
  };
}
