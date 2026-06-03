export const getPersistedChatConversationId = (
  location: string | null,
): string | null => {
  if (!location?.startsWith("/chat?")) return null;
  try {
    const search = location.slice(location.indexOf("?") + 1);
    const conversationId = new URLSearchParams(search).get("c")?.trim();
    return conversationId || null;
  } catch {
    return null;
  }
};
