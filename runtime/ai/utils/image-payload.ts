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
 * Single shared ceiling on the base64 payload of an inline image, matched to
 * Anthropic's documented per-image limit (5MB) — users hit real 400s at that
 * size. It is enforced against the base64 *string* length (what the API
 * actually counts), NOT the decoded byte length.
 *
 * This is the one source of truth for both boundaries that guard inline
 * images, so an image can never pass one and then be silently dropped by the
 * other:
 *   - the tool-attach gate in kernel/agent-runtime/tool-adapters.ts, and
 *   - the Anthropic send boundary in providers/anthropic.ts (via
 *     `sanitizeInlineImagePayload`).
 *
 * Well-behaved callers resize below this at attach time; this stays a
 * last-resort guard for payloads that slipped through.
 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

const DATA_URL_PREFIX_RE = /^data:([^;,]+)(;base64)?,/i;

/**
 * Detect a supported image media type purely from magic bytes.
 *
 * NOTE: this intentionally duplicates `detectImageMimeTypeFromBytes` in
 * runtime/kernel/shared/image-mime.ts. The `ai` layer must not import from
 * `kernel`, so the sniffing logic is mirrored rather than shared. Keep the two
 * in sync — if you add or adjust a format here, mirror it there (and vice
 * versa) so they don't silently drift.
 */
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
 * Bounded trailing windows for terminator scans (see `tailContainsMarker`).
 * The distinctive multi-byte markers (PNG's IEND+CRC, JPEG's EOI) tolerate a
 * wider window without false-accepting a truncated stream; GIF's single-byte
 * trailer needs a tight window so a cut-off LZW stream (whose bytes can be
 * anything, incl. 0x3B) doesn't read as complete.
 */
const MULTIBYTE_TERMINATOR_SCAN_WINDOW = 256;
const GIF_TERMINATOR_SCAN_WINDOW = 8;

/**
 * Scan the trailing `window` bytes for `marker`, matching it anywhere in that
 * window rather than requiring it to be the exact final bytes. Real, valid
 * images frequently carry a little data after their terminator (exporter
 * metadata after a PNG's IEND, padding or an appended thumbnail after a JPEG's
 * EOI); demanding an exact tail match false-rejects them and drops a good
 * image to a "[Image omitted]" note. The window stays bounded and we only scan
 * the tail — a genuinely truncated stream (no terminator present near the end)
 * is still rejected, so truncation detection isn't weakened.
 */
const tailContainsMarker = (
	bytes: Uint8Array,
	marker: readonly number[],
	window: number,
): boolean => {
	if (marker.length === 0 || bytes.length < marker.length) return false;
	const lastStart = bytes.length - marker.length;
	const earliestStart = Math.max(0, bytes.length - window);
	for (let i = lastStart; i >= earliestStart; i--) {
		let matched = true;
		for (let j = 0; j < marker.length; j++) {
			if (bytes[i + j] !== marker[j]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
};

/**
 * Structural completeness check per format. This is what catches the
 * truncated-screenshot bug: the header is intact but the stream is cut off
 * before its terminator, so the provider can't decode it. The terminator is
 * scanned for within a bounded trailing window (not required to be the exact
 * final bytes) so valid images with trailing data still pass.
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
			return tailContainsMarker(
				bytes,
				[0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
				MULTIBYTE_TERMINATOR_SCAN_WINDOW,
			);
		}
		case "image/jpeg": {
			// Complete JPEGs end with the EOI marker 0xFFD9.
			if (bytes.length < 4) return false;
			return tailContainsMarker(bytes, [0xff, 0xd9], MULTIBYTE_TERMINATOR_SCAN_WINDOW);
		}
		case "image/gif": {
			// Complete GIFs end with the trailer byte 0x3B.
			if (bytes.length < 6) return false;
			return tailContainsMarker(bytes, [0x3b], GIF_TERMINATOR_SCAN_WINDOW);
		}
		case "image/webp": {
			// The RIFF header declares the payload size in bytes 4..8 (LE);
			// the file is complete when it contains that many bytes after the
			// 8-byte RIFF/size preamble. Read as unsigned (`>>> 0`) so a
			// declared size with bit 31 set (>= 2GiB) doesn't come out negative
			// from the signed `<< 24` and wrongly pass the length check.
			if (bytes.length < 12) return false;
			const declared =
				(bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
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
