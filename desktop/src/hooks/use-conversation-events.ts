import { useQuery } from "convex/react";
import { api } from "../convex/api";

export type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
};

export const useConversationEvents = (conversationId?: string) => {
  const result = useQuery(
    api.events.listEvents,
    conversationId
      ? { conversationId, paginationOpts: { cursor: null, numItems: 200 } }
      : "skip",
  ) as { page: EventRecord[] } | undefined;

  const events = result?.page ?? [];
  return [...events].reverse();
};
