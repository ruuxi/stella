import { promises as fs } from "node:fs";

import {
  detectImageMediaType,
  isCompleteImage,
  type SupportedImageMediaType,
} from "../../ai/utils/image-payload.js";
import { loadPhoton } from "../shared/photon.js";

export const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_EDGE_PIXELS = 16_384;
export const MAX_IMAGE_TOTAL_PIXELS = 100_000_000;
export const MAX_IMAGE_FRAMES = 300;
export const MAX_IMAGE_DECODED_BYTES = 400 * 1024 * 1024;

export type DecodedImageInfo = {
  mimeType: SupportedImageMediaType;
  width: number;
  height: number;
};

type EncodedImageInfo = DecodedImageInfo & { frames: number };

const assertResourceBudget = (info: EncodedImageInfo): void => {
  const pixels = info.width * info.height;
  if (
    info.width > MAX_IMAGE_EDGE_PIXELS ||
    info.height > MAX_IMAGE_EDGE_PIXELS ||
    pixels > MAX_IMAGE_TOTAL_PIXELS ||
    info.frames > MAX_IMAGE_FRAMES ||
    pixels * 4 * info.frames > MAX_IMAGE_DECODED_BYTES
  ) {
    throw new Error("image exceeds Stella's safe decode resource limits");
  }
};

const readJpegDimensions = (
  bytes: Uint8Array,
): { width: number; height: number } | null => {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) &&
      length >= 7
    ) {
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += length;
  }
  return null;
};

/** Parse only bounded container headers before handing untrusted bytes to WASM. */
export const inspectEncodedImage = (
  bytes: Uint8Array,
): EncodedImageInfo | null => {
  const mimeType = detectImageMediaType(bytes);
  if (!mimeType) return null;
  let width = 0;
  let height = 0;
  let frames = 1;
  if (mimeType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16, false);
    height = view.getUint32(20, false);
  } else if (mimeType === "image/gif" && bytes.length >= 10) {
    width = bytes[6]! | (bytes[7]! << 8);
    height = bytes[8]! | (bytes[9]! << 8);
    frames = 0;
    for (
      let index = 13;
      index < bytes.length && frames <= MAX_IMAGE_FRAMES;
      index += 1
    ) {
      if (bytes[index] === 0x2c) frames += 1;
    }
    frames = Math.max(1, frames);
  } else if (mimeType === "image/jpeg") {
    const dimensions = readJpegDimensions(bytes);
    if (dimensions) ({ width, height } = dimensions);
  } else if (mimeType === "image/webp" && bytes.length >= 30) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      if ((bytes[20]! & 0x02) !== 0) {
        frames = 0;
        for (
          let index = 30;
          index + 4 <= bytes.length && frames <= MAX_IMAGE_FRAMES;
          index += 1
        ) {
          if (
            String.fromCharCode(...bytes.subarray(index, index + 4)) === "ANMF"
          )
            frames += 1;
        }
        frames = Math.max(1, frames);
      }
    } else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits =
        bytes[21]! |
        (bytes[22]! << 8) |
        (bytes[23]! << 16) |
        (bytes[24]! << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 " && bytes.length >= 30) {
      width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
      height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    }
  }
  if (!width || !height) return null;
  const info = { mimeType, width, height, frames };
  assertResourceBudget(info);
  return info;
};

export const decodeBase64ImageBounded = (
  encoded: string,
  maxBytes = MAX_GENERATED_IMAGE_BYTES,
): Buffer => {
  const normalized = encoded.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized))
    throw new Error("image base64 is invalid");
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  const decodedLength = Math.floor((normalized.length * 3) / 4) - padding;
  if (decodedLength <= 0 || decodedLength > maxBytes)
    throw new Error(`image exceeds the ${maxBytes} byte limit`);
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length !== decodedLength)
    throw new Error("image base64 is invalid");
  return bytes;
};

export const readResponseBodyBounded = async (
  response: Response,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Buffer> => {
  const maxBytes = options.maxBytes ?? MAX_GENERATED_IMAGE_BYTES;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`image exceeds the ${maxBytes} byte limit`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () =>
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (options.signal?.aborted)
        throw options.signal.reason ?? new Error("Image download canceled.");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("image byte limit exceeded").catch(() => undefined);
        throw new Error(`image exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
};

/**
 * Fail-closed image validation used before references or generated artifacts
 * cross a trust boundary. Signatures and terminators are only prefilters;
 * Photon must decode the complete pixel structure before the image is valid.
 */
export const decodeAndValidateImage = async (
  bytes: Uint8Array,
): Promise<DecodedImageInfo | null> => {
  const mimeType = detectImageMediaType(bytes);
  if (!mimeType || !isCompleteImage(bytes, mimeType)) return null;
  let encoded: EncodedImageInfo | null;
  try {
    encoded = inspectEncodedImage(bytes);
  } catch {
    return null;
  }
  if (!encoded) return null;
  const photon = await loadPhoton();
  if (!photon) return null;
  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | null =
    null;
  try {
    image = photon.PhotonImage.new_from_byteslice(bytes);
    const width = image.get_width();
    const height = image.get_height();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1
    ) {
      return null;
    }
    if (width !== encoded.width || height !== encoded.height) return null;
    return { mimeType, width, height };
  } catch {
    return null;
  } finally {
    image?.free();
  }
};

export const validateDecodedImageFile = async (
  filePath: string,
  expectedMimeType?: string,
): Promise<boolean> => {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return false;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_GENERATED_IMAGE_BYTES
    ) {
      return false;
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) return false;
      offset += result.bytesRead;
    }
    const finalStat = await handle.stat();
    if (
      finalStat.size !== stat.size ||
      finalStat.dev !== stat.dev ||
      finalStat.ino !== stat.ino
    ) {
      return false;
    }
    const decoded = await decodeAndValidateImage(bytes);
    return Boolean(
      decoded && (!expectedMimeType || decoded.mimeType === expectedMimeType),
    );
  } finally {
    await handle.close();
  }
};
