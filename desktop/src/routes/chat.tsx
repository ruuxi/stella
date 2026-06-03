import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { ChatApp } from "@/app/chat/App";

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
  // every caller, the route backfills the conversation from the durable
  // active-conversation pointer (SQLite). This makes the route incapable of
  // "losing" the conversation — `?c=` is always re-derived from the one
  // source of truth.
  beforeLoad: async ({ search }) => {
    if (search.c) return;
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
