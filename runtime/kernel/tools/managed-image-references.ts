import type { ToolContext } from "./types.js";
import {
  decodeAndValidateImage,
  decodeBase64ImageBounded,
} from "./image-decode-validation.js";
import {
  MAX_IMAGE_REFERENCE_BYTES,
  readAuthorizedImageReference,
} from "./image-reference-policy.js";
import { loadPhoton } from "../shared/photon.js";

export const MAX_MANAGED_IMAGE_REFERENCE_ITEMS = 4;
export const MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES = 1024 * 1024;
export const MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_MANAGED_IMAGE_REFERENCE_SERIALIZED_CHARS =
  Math.ceil(MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES / 3) * 4 +
  MAX_MANAGED_IMAGE_REFERENCE_ITEMS * 64;
export const MAX_MANAGED_IMAGE_REMOTE_URL_CHARS = 8 * 1024;
export const MAX_MANAGED_IMAGE_REFERENCE_EDGE = 1600;
export const MAX_MANAGED_IMAGE_REQUEST_BYTES = 3 * 1024 * 1024;

type PreparedManagedReference = {
  dataUri: string;
  byteLength: number;
  width: number;
  height: number;
};

const dataUri = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

const validatedDataUriBytes = async (
  value: string,
): Promise<{ bytes: Buffer; mimeType: string }> => {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("reference data URI must be base64 encoded");
  const bytes = decodeBase64ImageBounded(match[2], MAX_IMAGE_REFERENCE_BYTES);
  const decoded = await decodeAndValidateImage(bytes);
  const claimedMime = match[1].trim().toLowerCase();
  if (!decoded || decoded.mimeType !== claimedMime) {
    throw new Error(
      "reference data URI MIME type does not match supported image bytes",
    );
  }
  return { bytes, mimeType: decoded.mimeType };
};

/**
 * Managed references use a deliberately smaller wire representation than the
 * 20 MiB safe-read allowance. Small images remain byte-identical. Larger
 * images are bounded to 1600 px and progressively JPEG-encoded until they fit
 * the per-item share of the aggregate request envelope.
 */
export const normalizeManagedImageReferenceBytes = async (
  bytes: Uint8Array,
  mimeType: string,
  maxBytes = MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES,
): Promise<PreparedManagedReference> => {
  if (maxBytes < 1 || maxBytes > MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES) {
    throw new Error("managed reference normalization budget is invalid");
  }
  const decoded = await decodeAndValidateImage(bytes);
  if (!decoded || decoded.mimeType !== mimeType) {
    throw new Error("managed reference is not a complete supported image");
  }
  if (
    bytes.byteLength <= maxBytes &&
    Math.max(decoded.width, decoded.height) <= MAX_MANAGED_IMAGE_REFERENCE_EDGE
  ) {
    return {
      dataUri: dataUri(decoded.mimeType, bytes),
      byteLength: bytes.byteLength,
      width: decoded.width,
      height: decoded.height,
    };
  }

  const photon = await loadPhoton();
  if (!photon) {
    throw new Error("managed reference normalization is unavailable");
  }
  const original = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    const originalWidth = original.get_width();
    const originalHeight = original.get_height();
    const edgeCandidates = [1600, 1400, 1200, 1024, 896, 768, 640, 512, 384];
    const qualities = [82, 74, 66, 58, 50, 42];
    for (const edge of edgeCandidates) {
      const scale = Math.min(1, edge / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const resized =
        width === originalWidth && height === originalHeight
          ? null
          : photon.resize(
              original,
              width,
              height,
              photon.SamplingFilter.Lanczos3,
            );
      const candidate = resized ?? original;
      try {
        for (const quality of qualities) {
          const encoded = candidate.get_bytes_jpeg(quality);
          if (encoded.byteLength > maxBytes) continue;
          const verified = await decodeAndValidateImage(encoded);
          if (!verified || verified.mimeType !== "image/jpeg") continue;
          return {
            dataUri: dataUri("image/jpeg", encoded),
            byteLength: encoded.byteLength,
            width: verified.width,
            height: verified.height,
          };
        }
      } finally {
        resized?.free();
      }
    }
  } finally {
    original.free();
  }
  throw new Error(
    `managed reference could not be normalized below ${maxBytes} bytes`,
  );
};

export const prepareManagedImageReferences = async (args: {
  paths: readonly string[];
  urls: readonly string[];
  context: ToolContext;
}): Promise<string[]> => {
  const itemCount = args.paths.length + args.urls.length;
  if (itemCount > MAX_MANAGED_IMAGE_REFERENCE_ITEMS) {
    throw new Error(
      `image_gen accepts at most ${MAX_MANAGED_IMAGE_REFERENCE_ITEMS} reference images`,
    );
  }
  const inlineCount =
    args.paths.length +
    args.urls.filter((url) => /^data:image\//i.test(url)).length;
  let remainingInline = inlineCount;
  let remainingBytes = MAX_MANAGED_IMAGE_REFERENCE_TOTAL_BYTES;
  let serializedChars = 0;
  const out: string[] = [];

  const appendInline = async (bytes: Buffer, mimeType: string) => {
    const itemBudget = Math.min(
      MAX_MANAGED_IMAGE_REFERENCE_ITEM_BYTES,
      Math.floor(remainingBytes / Math.max(1, remainingInline)),
    );
    const prepared = await normalizeManagedImageReferenceBytes(
      bytes,
      mimeType,
      itemBudget,
    );
    remainingInline -= 1;
    remainingBytes -= prepared.byteLength;
    serializedChars += prepared.dataUri.length;
    if (
      remainingBytes < 0 ||
      serializedChars > MAX_MANAGED_IMAGE_REFERENCE_SERIALIZED_CHARS
    ) {
      throw new Error("managed reference images exceed the aggregate limit");
    }
    out.push(prepared.dataUri);
  };

  for (const filePath of args.paths) {
    const reference = await readAuthorizedImageReference(
      filePath,
      args.context,
    );
    await appendInline(reference.bytes, reference.mimeType);
  }
  for (const url of args.urls) {
    if (/^data:image\//i.test(url)) {
      const reference = await validatedDataUriBytes(url);
      await appendInline(reference.bytes, reference.mimeType);
      continue;
    }
    if (url.length > MAX_MANAGED_IMAGE_REMOTE_URL_CHARS) {
      throw new Error(
        `managed reference URL exceeds ${MAX_MANAGED_IMAGE_REMOTE_URL_CHARS} characters`,
      );
    }
    out.push(url);
  }
  return out;
};
