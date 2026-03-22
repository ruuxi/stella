const MAX_URL_LENGTH = 4096;
const MAX_DATA_URL_LENGTH = 16 * 1024 * 1024;

const sanitizeUrl = (
  value: unknown,
  allowedProtocols: ReadonlySet<string>,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const maxLength = trimmed.startsWith("data:")
    ? MAX_DATA_URL_LENGTH
    : MAX_URL_LENGTH;
  if (trimmed.length > maxLength) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!allowedProtocols.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
};

const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);
const ATTACHMENT_IMAGE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "data:",
  "blob:",
  "file:",
]);

export const sanitizeExternalLinkUrl = (value: unknown): string | null =>
  sanitizeUrl(value, EXTERNAL_LINK_PROTOCOLS);

export const sanitizeAttachmentImageUrl = (value: unknown): string | null =>
  sanitizeUrl(value, ATTACHMENT_IMAGE_PROTOCOLS);
