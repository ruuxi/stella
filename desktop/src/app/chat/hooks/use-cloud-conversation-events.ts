import { usePaginatedQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@/convex/api";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

export const CLOUD_EVENT_PAGE_SIZE = 200;

const EMPTY_EVENTS: EventRecord[] = [];
const NO_OP = () => {};

export type CloudConversationStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

type PaginatedEventsResult = {
  results: EventRecord[];
  status: CloudConversationStatus;
  loadMore: (numItems: number) => void;
};

type UseCloudConversationEventsOptions = {
  conversationId: string | undefined;
  enabled: boolean;
};

type UseCloudConversationEventsResult = {
  /** Events in chronological order (the Convex query returns reversed). */
  events: EventRecord[];
  status: CloudConversationStatus;
  loadMore: (numItems: number) => void;
};

/**
 * Convex `usePaginatedQuery` wrapper for cloud-backed conversations.
 * Reverses the descending pagination order into chronological order
 * here so consumers don't have to care.
 */
export function useCloudConversationEvents({
  conversationId,
  enabled,
}: UseCloudConversationEventsOptions): UseCloudConversationEventsResult {
  const result = usePaginatedQuery(
    api.events.listEvents,
    enabled && conversationId ? { conversationId } : "skip",
    { initialNumItems: CLOUD_EVENT_PAGE_SIZE },
  ) as PaginatedEventsResult | undefined;

  const results = result?.results ?? EMPTY_EVENTS;
  const status = result?.status ?? "Exhausted";
  const loadMore = result?.loadMore ?? NO_OP;

  const events = useMemo(
    () => (enabled ? [...results].reverse() : EMPTY_EVENTS),
    [enabled, results],
  );

  return { events, status, loadMore };
}
