/**
 * File-level helpers for the Media tab: drag/drop classification,
 * data-uri conversion, and local-import wiring through the desktop
 * media `saveOutput` IPC.
 */
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { payloadToTabSpec } from "../payload-to-tab-spec";
import { displayTabs } from "../tab-store";

export const SUPPORTED_MEDIA_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
] as const;
export const SUPPORTED_MEDIA_ACCEPT = "image/*,video/*,audio/*";

export const isSupportedMediaMime = (type: string): boolean =>
  SUPPORTED_MEDIA_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));

export const isSupportedMediaFile = (file: File): boolean =>
  isSupportedMediaMime(file.type);

export const dataTransferHasSupportedMedia = (
  event: React.DragEvent,
): boolean => {
  const items = event.dataTransfer?.items;
  if (!items || items.length === 0) return false;
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (!item.type || isSupportedMediaMime(item.type)) return true;
  }
  return false;
};

export const fileToDataUri = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

// Tiny base64 encoder for Uint8Array. Used only when we need to feed a
// `data:` URI into a downstream API (e.g. the media generation source
// hand-off). For the generic byte-shipping path we keep raw `Uint8Array`
// in `useDisplayFileBytes` and avoid this conversion entirely.
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += BASE64_ALPHABET[b2 & 0x3f]!;
  }
  if (i < bytes.length) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    out += BASE64_ALPHABET[b0 >> 2]!;
    if (b1 === undefined) {
      out += BASE64_ALPHABET[(b0 & 0x03) << 4]!;
      out += "==";
    } else {
      out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
      out += BASE64_ALPHABET[(b1 & 0x0f) << 2]!;
      out += "=";
    }
  }
  return out;
};

export const readSourceAsDataUri = async (
  filePath: string,
): Promise<string | null> => {
  const result = await window.electronAPI?.display?.readFile?.(filePath);
  if (!result || result.missing) return null;
  return `data:${result.mimeType};base64,${bytesToBase64(result.bytes)}`;
};

const assetForImportedFile = (
  file: File,
  filePath: string,
): Extract<DisplayPayload, { kind: "media" }>["asset"] | null => {
  if (file.type.startsWith("image/")) {
    return { kind: "image", filePaths: [filePath] };
  }
  if (file.type.startsWith("video/")) {
    return { kind: "video", filePath };
  }
  if (file.type.startsWith("audio/")) {
    return { kind: "audio", filePath };
  }
  return null;
};

export const importLocalMedia = async (file: File): Promise<void> => {
  const saveApi = window.electronAPI?.media?.saveOutput;
  if (!saveApi) throw new Error("Media import is not available");
  const dataUri = await fileToDataUri(file);
  const safeBase = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "import";
  const result = await saveApi(dataUri, `imported-${Date.now()}-${safeBase}`);
  if (!result.ok || !result.path) {
    throw new Error(result.error ?? "Could not save imported file");
  }
  const asset = assetForImportedFile(file, result.path);
  if (!asset) throw new Error("Unsupported file type");
  const payload: DisplayPayload = {
    kind: "media",
    asset,
    capability: "imported",
    createdAt: Date.now(),
  };
  displayTabs.openTab(payloadToTabSpec(payload));
};
