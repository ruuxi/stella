/**
 * Synchronous renderer-side cache of the active conversation id.
 *
 * The durable source of truth lives in SQLite (written via
 * `setActiveLocalConversationId` from `__root`). That pointer is correct but
 * only reachable through an async IPC round-trip, which is too slow for the
 * boot path: on a renderer hard reload the memory-history router resets
 * `/chat?c=<id>` back to plain `/chat`, so the `/chat` route has to re-derive
 * `?c=` before the chat surface can render the previous conversation. Doing
 * that via IPC leaves the surface empty until the round-trip resolves — the
 * "it reloads the chat instead of preserving the previous one" flash.
 *
 * This cache mirrors the same id into the shared UI state store so the route can redirect
 * synchronously on reload. It is deliberately a dedicated key (not the
 * persisted route): we only ever write it from the *resolved*
 * `routerConversationId`, never from a stripped-`c` navigation, so it cannot
 * drift or be poisoned the way persisting `?c=` on the route would.
 */

import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:activeConversationId";

/** Conversation ids are ULIDs; cap and charset-check to reject junk. */
const MAX_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Read the cached active conversation id, or `null` if missing/invalid. */
export function readActiveConversationIdCache(): string | null {
  if (typeof window === "undefined") return null;
  const raw = uiState.getItem(STORAGE_KEY);
  if (!raw || raw.length > MAX_LENGTH || !ID_PATTERN.test(raw)) return null;
  return raw;
}

/** Cache the active conversation id. Silently noops on storage errors. */
export function writeActiveConversationIdCache(conversationId: string): void {
  if (typeof window === "undefined") return;
  if (
    !conversationId ||
    conversationId.length > MAX_LENGTH ||
    !ID_PATTERN.test(conversationId)
  ) {
    return;
  }
  uiState.setItem(STORAGE_KEY, conversationId);
}
