/**
 * Vision-input image resizing, ported from pi-mono's coding-agent
 * (`utils/image-resize-core.ts`). Guarantees every attached image fits
 * within provider dimension and byte limits at attach time, so history
 * never carries multi-megabyte base64 blocks:
 *
 * 1. Resize to maxWidth/maxHeight (Lanczos3)
 * 2. Try both PNG and JPEG encodings, pick the first under maxBytes
 *    (PNG is lossless and tried first, so text stays crisp whenever it fits)
 * 3. If still too large, walk JPEG quality down (90 → 40)
 * 4. If still too large, progressively shrink dimensions toward 1x1
 *
 * When the input already fits the target's dimension AND byte caps it is
 * passed through untouched — no needless lossy re-encode.
 *
 * Runs in-process: Stella's runtime worker is already a separate process
 * from the UI, so a brief WASM decode doesn't block anything user-facing.
 * Returns null when Photon is unavailable or the image can't be decoded
 * or shrunk under the cap — callers decide the fallback.
 */

import {
  DEFAULT_JPEG_QUALITY,
  SAFE_FALLBACK_MAX_BYTES,
  SAFE_FALLBACK_MAX_EDGE,
} from "../../ai/utils/image-caps.js";
import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

export interface ImageResizeOptions {
  maxWidth?: number; // Default: safe-fallback long edge (2048)
  maxHeight?: number; // Default: safe-fallback long edge (2048)
  maxBytes?: number; // Default: safe-fallback base64 budget (~4.5MB)
  jpegQuality?: number; // Default: 90
}

export interface ResizedImage {
  data: string; // base64
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

// Safe conservative defaults, used only when a caller does not pass
// provider-aware caps. Callers should resolve caps via `resolveImageCaps`
// (ai/utils/image-caps) so images reach each provider at the best quality it
// supports; these defaults stay under every mainstream provider's per-image
// cap for the unknown-route case.
const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: SAFE_FALLBACK_MAX_EDGE,
  maxHeight: SAFE_FALLBACK_MAX_EDGE,
  maxBytes: SAFE_FALLBACK_MAX_BYTES,
  jpegQuality: DEFAULT_JPEG_QUALITY,
};

interface EncodedCandidate {
  data: string;
  encodedSize: number;
  mimeType: string;
}

const encodeCandidate = (
  buffer: Uint8Array,
  mimeType: string,
): EncodedCandidate => {
  const data = Buffer.from(buffer).toString("base64");
  return {
    data,
    encodedSize: Buffer.byteLength(data, "utf-8"),
    mimeType,
  };
};

export const resizeImage = async (
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

  const photon = await loadPhoton();
  if (!photon) {
    return null;
  }

  let image:
    | ReturnType<typeof photon.PhotonImage.new_from_byteslice>
    | undefined;
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
    image = applyExifOrientation(photon, rawImage, inputBytes);
    if (image !== rawImage) rawImage.free();

    const originalWidth = image.get_width();
    const originalHeight = image.get_height();
    const format = mimeType.split("/")[1] ?? "png";

    // Check if already within all limits (dimensions AND encoded size)
    if (
      originalWidth <= opts.maxWidth &&
      originalHeight <= opts.maxHeight &&
      inputBase64Size < opts.maxBytes
    ) {
      return {
        data: Buffer.from(inputBytes).toString("base64"),
        mimeType: mimeType || `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    // Calculate initial dimensions respecting max limits
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (targetWidth > opts.maxWidth) {
      targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
      targetWidth = opts.maxWidth;
    }
    if (targetHeight > opts.maxHeight) {
      targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
      targetHeight = opts.maxHeight;
    }

    const tryEncodings = (
      width: number,
      height: number,
      jpegQualities: number[],
    ): EncodedCandidate[] => {
      const resized = photon.resize(
        image!,
        width,
        height,
        photon.SamplingFilter.Lanczos3,
      );

      try {
        const candidates: EncodedCandidate[] = [
          encodeCandidate(resized.get_bytes(), "image/png"),
        ];
        for (const quality of jpegQualities) {
          candidates.push(
            encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"),
          );
        }
        return candidates;
      } finally {
        resized.free();
      }
    };

    // Try the caller's quality first (default q90), then step down only as
    // needed to fit the byte cap; heavy JPEG compression is the classic cause
    // of illegible text, so we start high rather than at the old q80.
    const qualitySteps = Array.from(
      new Set([opts.jpegQuality, 90, 80, 70, 55, 40]),
    );
    let currentWidth = targetWidth;
    let currentHeight = targetHeight;

    while (true) {
      const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
      for (const candidate of candidates) {
        if (candidate.encodedSize < opts.maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width: currentWidth,
            height: currentHeight,
            wasResized: true,
          };
        }
      }

      if (currentWidth === 1 && currentHeight === 1) {
        break;
      }

      const nextWidth =
        currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
      const nextHeight =
        currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
      if (nextWidth === currentWidth && nextHeight === currentHeight) {
        break;
      }

      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (image) {
      image.free();
    }
  }
};

/**
 * Format a dimension note for resized images so the model can map its
 * output coordinates back to the original image space.
 */
export const formatDimensionNote = (
  result: ResizedImage,
): string | undefined => {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
};
