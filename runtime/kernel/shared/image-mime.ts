export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export const detectImageMimeTypeFromBytes = (
  bytes: Uint8Array,
): SupportedImageMimeType | null => {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
  }

  if (bytes.length >= 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
  }

  if (bytes.length >= 6) {
    const header = new TextDecoder().decode(bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }

  if (bytes.length >= 12) {
    const riff = new TextDecoder().decode(bytes.slice(0, 4));
    const webp = new TextDecoder().decode(bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") {
      return "image/webp";
    }
  }

  return null;
};

export const imageMimeTypeFromPath = (
  filePath: string,
): SupportedImageMimeType | null => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
};

export const resolveImageMimeType = (
  filePath: string,
  bytes: Uint8Array,
): SupportedImageMimeType | null =>
  detectImageMimeTypeFromBytes(bytes) ?? imageMimeTypeFromPath(filePath);
