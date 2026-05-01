import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ChatApp } from "@/app/chat/App";

/**
 * `?c=<conversationId>` is the canonical chat-route search param. We use a
 * search param (not a path param) so `/chat` with no conversation can still
 * render the home pane while the bootstrap is preparing one.
 */
const ChatSearch = z.object({
  c: z.string().optional(),
});

export const Route = createFileRoute("/chat")({
  validateSearch: ChatSearch,
  component: ChatApp,
});
