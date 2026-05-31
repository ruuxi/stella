import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";
import { getLatestAssistantPreview } from "@/features/chat/lib/latest-assistant-preview";

type UseAssistantReplyPeekOptions = {
  messages: MessageRecord[];
  /** True while stream/send auto-follow is armed (i.e. user is at the tail). */
  isFollowingLatest: boolean;
};

/**
 * Surface a one-line preview of the latest assistant message — but only
 * for messages that arrived AFTER the user left the live tail. If the
 * user scrolls up while already looking at the most recent reply, no
 * peek (they've already seen it); the peek appears the moment a newer
 * assistant message lands while they're still scrolled away.
 */
export function useAssistantReplyPeek({
  messages,
  isFollowingLatest,
}: UseAssistantReplyPeekOptions) {
  const latest = useMemo(() => getLatestAssistantPreview(messages), [messages]);
  const latestId = latest?.id ?? null;

  // While the user is following the tail, keep the baseline pinned to
  // the latest assistant message id — anything at or before this id was
  // already on screen for them. When they scroll away, the baseline
  // freezes and any newer assistant id flips the peek visible.
  const [baselineId, setBaselineId] = useState<string | null>(latestId);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (isFollowingLatest) setBaselineId(latestId);
  }, [isFollowingLatest, latestId]);

  const dismiss = useCallback(() => {
    if (latestId) setDismissedId(latestId);
  }, [latestId]);

  const visible =
    latest !== null &&
    !isFollowingLatest &&
    latestId !== baselineId &&
    latestId !== dismissedId;

  return {
    visible,
    previewText: latest?.text ?? "",
    dismiss,
  };
}
