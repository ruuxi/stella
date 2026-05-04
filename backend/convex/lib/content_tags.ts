const BLOCKED_CONTENT_TAGS = new Set(["nsfw"]);

export const isBlockedContentTag = (tag: string): boolean =>
  BLOCKED_CONTENT_TAGS.has(tag.trim().toLowerCase());

export const filterDisplayableTags = (tags: string[]): string[] =>
  tags.filter((tag) => !isBlockedContentTag(tag));
