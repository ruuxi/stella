import { promises as fs } from "node:fs";

import {
  detectImageMediaType,
  isCompleteImage,
  type SupportedImageMediaType,
} from "../../ai/utils/image-payload.js";
import { loadPhoton } from "../shared/photon.js";

export type DecodedImageInfo = {
  mimeType: SupportedImageMediaType;
  width: number;
  height: number;
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
  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) return false;
  const decoded = await decodeAndValidateImage(bytes);
  return Boolean(
    decoded && (!expectedMimeType || decoded.mimeType === expectedMimeType),
  );
};
