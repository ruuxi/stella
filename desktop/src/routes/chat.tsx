import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { ChatApp } from "@/app/chat/App";
import { readActiveConversationIdCache } from "@/features/chat/services/active-conversation-cache";

/**
 * `?c=<conversationId>` is the canonical chat-route search param and the
 * single live source of truth for which conversation is active. We use a
 * search param (not a path param) so `/chat` with no conversation can still
 * render the home pane while the bootstrap is preparing one.
 */
const ChatSearch = z.object({
  c: z.string().optional(),
});

export const Route = createFileRoute("/chat")({
  validateSearch: ChatSearch,
  // Self-heal a missing `?c=`. The router uses memory history, so a renderer
  // hard reload resets `/chat?c=<id>` back to plain `/chat`; other call sites
  // also navigate to `/chat` without preserving the search. Rather than patch
  // every caller, the route backfills the conversation from the active
  // conversation pointer. This makes the route incapable of "losing" the
  // conversation — `?c=` is always re-derived from the source of truth.
  //
  // Fast path: a synchronous `localStorage` cache lets us redirect on the same
  // tick on reload, so the chat surface keeps the previous conversation
  // mounted instead of flashing the empty/home state while an IPC round-trip
  // resolves. The durable SQLite pointer is the cold-start fallback (fresh
  // install, or a cleared cache) and remains the source of truth.
  beforeLoad: async ({ search }) => {
    if (search.c) return;

    const cached = readActiveConversationIdCache();
    if (cached) {
      throw redirect({ to: "/chat", search: { c: cached }, replace: true });
    }

    const api = window.electronAPI?.localChat;
    if (!api) return;
    let activeConversationId: string | null = null;
    try {
      activeConversationId = await api.getOrCreateDefaultConversationId();
    } catch {
      activeConversationId = null;
    }
    if (activeConversationId) {
      throw redirect({
        to: "/chat",
        search: { c: activeConversationId },
        replace: true,
      });
    }
  },
  component: ChatApp,
});
