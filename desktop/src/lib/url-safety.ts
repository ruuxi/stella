const MAX_URL_LENGTH = 4096;

const sanitizeUrl = (
  value: unknown,
  allowedProtocols: ReadonlySet<string>,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
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

export const sanitizeCanvasAppUrl = (value: unknown): string | null =>
  sanitizeExternalLinkUrl(value);
