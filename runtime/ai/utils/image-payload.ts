/**
 * Provider-agnostic validation/repair for inline (base64) vision image
 * payloads before they are attached to a model request.
 *
 * Motivation: tool-produced images (screenshots, browser captures,
 * `view_image` file reads) can reach the request in shapes the provider
 * rejects — most importantly a *truncated / corrupt* image whose bytes were
 * captured mid-write. The base64 is clean and the header (e.g. PNG IHDR)
 * parses, so nothing upstream notices, but the pixel stream is incomplete.
 * Anthropic decodes the image server-side and answers the whole request with
 * a fatal `400 "Could not process image"`. Because the bad block is persisted
 * in thread history, every subsequent resume re-sends it and re-fails.
 *
 * User-attached images never hit this: they come from complete files the user
 * selected. This is why the bug is specific to the tool-produced path.
 *
 * This module runs in the `ai` layer (which must not depend on `kernel`), so
 * it is intentionally self-contained: pure byte inspection, no Photon/WASM.
 * It cannot re-encode a truly undecodable image (nothing can — the pixels are
 * gone), so an unprocessable block is dropped and the caller substitutes a
 * short text note instead of poisoning the request. Valid images pass through
 * untouched, so the working user-attached path does not regress.
 */

/** Media types Anthropic (and the other vision providers) accept as base64. */
export type SupportedImageMediaType =
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp";

const SUPPORTED_MEDIA_TYPES: readonly SupportedImageMediaType[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];

/**
 * Hard ceiling on the base64 payload, matched to Anthropic's documented
 * per-image limit (5MB). Well-behaved callers resize below this at attach
 * time; this is only a last-resort guard for payloads that slipped through.
 */
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

const DATA_URL_PREFIX_RE = /^data:([^;,]+)(;base64)?,/i;

/** Detect a supported image media type purely from magic bytes. */
export const detectImageMediaType = (
	bytes: Uint8Array,
): SupportedImageMediaType | null => {
	if (
		bytes.length >= 8 &&
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
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 6) {
		const header = String.fromCharCode(...bytes.slice(0, 6));
		if (header === "GIF87a" || header === "GIF89a") {
			return "image/gif";
		}
	}
	if (bytes.length >= 12) {
		const riff = String.fromCharCode(...bytes.slice(0, 4));
		const webp = String.fromCharCode(...bytes.slice(8, 12));
		if (riff === "RIFF" && webp === "WEBP") {
			return "image/webp";
		}
	}
	return null;
};

/**
 * Structural completeness check per format. This is what catches the
 * truncated-screenshot bug: the header is intact but the stream is cut off
 * before its terminator, so the provider can't decode it.
 */
export const isCompleteImage = (
	bytes: Uint8Array,
	mediaType: SupportedImageMediaType,
): boolean => {
	switch (mediaType) {
		case "image/png": {
			// A complete PNG ends with the IEND chunk: "IEND" + its fixed CRC
			// (0xAE426082). The chunk carries no data, so the CRC is constant.
			if (bytes.length < 12) return false;
			const tail = bytes.slice(bytes.length - 8);
			return (
				tail[0] === 0x49 && // I
				tail[1] === 0x45 && // E
				tail[2] === 0x4e && // N
				tail[3] === 0x44 && // D
				tail[4] === 0xae &&
				tail[5] === 0x42 &&
				tail[6] === 0x60 &&
				tail[7] === 0x82
			);
		}
		case "image/jpeg": {
			// Complete JPEGs end with the EOI marker 0xFFD9.
			if (bytes.length < 4) return false;
			return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
		}
		case "image/gif": {
			// Complete GIFs end with the trailer byte 0x3B.
			if (bytes.length < 6) return false;
			return bytes[bytes.length - 1] === 0x3b;
		}
		case "image/webp": {
			// The RIFF header declares the payload size in bytes 4..8 (LE);
			// the file is complete when it contains that many bytes after the
			// 8-byte RIFF/size preamble.
			if (bytes.length < 12) return false;
			const declared =
				bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
			return bytes.length >= declared + 8;
		}
	}
};

const stripDataUrlPrefix = (data: string): string => {
	const match = DATA_URL_PREFIX_RE.exec(data);
	return match ? data.slice(match[0].length) : data;
};

const decodeBase64 = (data: string): Uint8Array | null => {
	const trimmed = stripDataUrlPrefix(data).trim();
	if (trimmed.length === 0) return null;
	try {
		const buf = Buffer.from(trimmed, "base64");
		if (buf.length === 0) return null;
		return buf;
	} catch {
		return null;
	}
};

export interface SanitizedImagePayload {
	mediaType: SupportedImageMediaType;
	/** Clean base64 (no data: URI prefix). */
	data: string;
}

/**
 * Validate/repair an inline image for a base64 vision source.
 *
 * Returns the canonicalized payload (media type corrected from the actual
 * bytes, data: URI prefix stripped) when the image is a complete, supported,
 * in-limit image. Returns `null` when the image is empty, malformed,
 * truncated/corrupt, an unsupported format, or exceeds the size ceiling — in
 * which case the caller should drop it rather than send an unprocessable
 * block that fails the entire request.
 */
export const sanitizeInlineImagePayload = (
	data: string,
	declaredMimeType: string | undefined,
): SanitizedImagePayload | null => {
	if (typeof data !== "string") return null;
	const bytes = decodeBase64(data);
	if (!bytes) return null;

	// Trust the bytes over the declared media type: screenshots frequently
	// carry a mislabeled or stale mime, and Anthropic sniffs the real format.
	const detected = detectImageMediaType(bytes);
	const declared = declaredMimeType?.split(";")[0]?.trim().toLowerCase();
	const mediaType =
		detected ??
		(declared && SUPPORTED_MEDIA_TYPES.includes(declared as SupportedImageMediaType)
			? (declared as SupportedImageMediaType)
			: null);

	// Unrecognized/unsupported format: the provider can't decode it either.
	if (!mediaType) return null;
	// If bytes don't match a supported signature at all, drop it — a declared
	// mime alone can't make unknown bytes decodable.
	if (!detected) return null;

	if (!isCompleteImage(bytes, mediaType)) return null;

	const clean = stripDataUrlPrefix(data).trim();
	if (clean.length > MAX_IMAGE_BASE64_BYTES) return null;

	return { mediaType, data: clean };
};
