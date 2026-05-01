import { useCallback, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";

export function useSocialMessages(roomId: string, currentOwnerId: string) {
  const messages = useQuery(api.social.messages.listRoomMessages, {
    roomId,
    limit: 50,
  });

  const sendMutation = useMutation(
    api.social.messages.sendRoomMessage,
  ).withOptimisticUpdate((localStore, args) => {
    const queryArgs = { roomId: args.roomId, limit: 50 };
    const existingMessages = localStore.getQuery(
      api.social.messages.listRoomMessages,
      queryArgs,
    );
    if (existingMessages === undefined) return;

    const now = Date.now();
    localStore.setQuery(api.social.messages.listRoomMessages, queryArgs, [
      ...existingMessages,
      {
        _id: `optimistic:${args.clientMessageId ?? now}`,
        _creationTime: now,
        roomId: args.roomId,
        senderOwnerId: currentOwnerId,
        clientMessageId: args.clientMessageId,
        kind: "text",
        body: args.body,
        moderationStatus: "pending",
        createdAt: now,
      },
    ]);
  });
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
