const LOCAL_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Local SQLite conversation IDs are ULID-like uppercase strings.
 * Cloud Convex APIs expect Convex document IDs, so ULIDs must never be passed.
 */
export const toCloudConversationId = (
  conversationId: string | null | undefined,
): string | null => {
  if (!conversationId) {
    return null;
  }
  if (LOCAL_ULID_REGEX.test(conversationId)) {
    return null;
  }
  return conversationId;
};

