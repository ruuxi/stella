/**
 * Visibility rule for inline connect cards on a chat surface.
 *
 * - Unscoped requests (no `conversationId` on the request — the legacy
 *   CLI bridge path) render on every surface.
 * - Scoped requests require an actual match: a surface that doesn't
 *   know its conversation (null/undefined) must NOT show another
 *   conversation's card.
 */
export const isConnectRequestVisibleToSurface = (
  request: { conversationId?: string },
  surfaceConversationId: string | null | undefined,
): boolean =>
  !request.conversationId ||
  (surfaceConversationId != null &&
    request.conversationId === surfaceConversationId);
