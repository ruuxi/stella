/**
 * Emoji pack generation pipeline (renderer side).
 *
 *   prompt → media-gateway text-to-image (one job per sheet)
 *          → fetch PNG → key magenta to alpha → encode WebP
 *          → presigned R2 PUT → `data.emoji_packs.createPack`
 *
 * The CLI script under `desktop/scripts/generate-emoji-sprite.ts` follows
 * the same logic but bypasses auth via `MEDIA_PUBLIC_TEST_MODE` and uses
 * `sharp` for image work. This module runs in the user's session (auth
 * headers attached automatically by `createServiceRequest`) and uses
 * Canvas2D so it works inside the Electron renderer.
 */

import { createServiceRequest } from "@/infra/http/service-request";
import {
  EMOJI_SHEETS,
  EMOJI_SHEET_GRID_SIZE,
} from "@/app/chat/emoji-sprites/cells";

export const EMOJI_SHEET_INDICES = [0, 1] as const;
export type EmojiSheetIndex = (typeof EMOJI_SHEET_INDICES)[number];

export type EmojiSheetBlob = {
  /** WebP encoded sheet, ready to PUT to R2. */
  blob: Blob;
  /** Lower-case hex SHA-256 of `blob`. */
  sha256: string;
  /** `URL.createObjectURL(blob)` for client-side preview. Caller is
   *  responsible for revoking it when done. */
  objectUrl: string;
  /** Pixel width of the encoded sheet. */
  width: number;
  /** Pixel height of the encoded sheet. */
  height: number;
};

const MEDIA_GENERATE_PATH = "/api/media/v1/generate";

const buildSheetPrompt = (sheetIndex: EmojiSheetIndex, style: string): string => {
  const list = EMOJI_SHEETS[sheetIndex];
  if (!list) throw new Error(`Unknown sheet index ${sheetIndex}`);
  const flat = list.join(" ");
  return [
    "Generate an image on a magenta background of emojis, on an 8x8 grid:",
    flat,
    `Inspired by: ${style.trim() || "playful party style"}`,
    [
      "Strict requirements (these override any interpretation of the inspiration above):",
      "- The background is a single uniform solid magenta color filling every pixel that is not part of an emoji glyph. Same shade everywhere — no gradient, no texture, no shading variation.",
      "- The canvas contains nothing other than the 64 emoji glyphs and the magenta background. No confetti, sparkles, streamers, decorative shapes, particles, borders, watermarks, or stray graphics anywhere — even if the inspiration would suggest them.",
      "- 8 rows, 8 columns. Each emoji occupies exactly one cell with consistent padding, fully contained within its cell. Cells are perfectly uniform in size.",
      "- Render in row-major order matching the list above (top-left is the first emoji, top-right is the eighth, bottom-right is the last).",
    ].join("\n"),
  ].join("\n\n");
};

export type SubmitJobResult = { jobId: string };

export const submitEmojiSheetJob = async (
  sheetIndex: EmojiSheetIndex,
  style: string,
): Promise<SubmitJobResult> => {
  const { endpoint, headers } = await createServiceRequest(
    MEDIA_GENERATE_PATH,
    { "Content-Type": "application/json" },
  );
  const body = {
    capability: "text_to_image",
    profile: "best",
    prompt: buildSheetPrompt(sheetIndex, style),
    input: {
      image_size: { width: 512, height: 512 },
      quality: "low",
      output_format: "png",
    },
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Generation failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  const json = (await res.json()) as { jobId?: string };
  if (!json.jobId) throw new Error("Generation response missing jobId");
  return { jobId: json.jobId };
};

/**
 * Pluck the first image URL out of a `media_jobs` document. The shape
 * matches what `media-store.extractOutput` reads, but we only care
 * about image-kind outputs here.
 */
export const extractFirstImageUrl = (output: unknown): string | null => {
  if (!output || typeof output !== "object") return null;
  const images = (output as { images?: Array<{ url?: string }> }).images;
  if (!Array.isArray(images)) return null;
  for (const entry of images) {
    if (entry && typeof entry.url === "string" && entry.url.length > 0) {
      return entry.url;
    }
  }
  return null;
};

const loadImageBitmap = async (url: string): Promise<ImageBitmap> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  const blob = await res.blob();
  return await createImageBitmap(blob);
};

type RGB = { r: number; g: number; b: number };

/** Median-RGB of a thin border strip — the actual background color the
 *  model painted, which we'll key against. Median (rather than mean)
 *  ignores stray glyph pixels that lap into the border. */
const detectBorderColor = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  borderPx: number,
): RGB => {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sample = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    rs.push(pixels[idx]!);
    gs.push(pixels[idx + 1]!);
    bs.push(pixels[idx + 2]!);
  };
  for (let y = 0; y < borderPx; y += 1) {
    for (let x = 0; x < width; x += 1) sample(x, y);
  }
  for (let y = height - borderPx; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) sample(x, y);
  }
  for (let x = 0; x < borderPx; x += 1) {
    for (let y = borderPx; y < height - borderPx; y += 1) sample(x, y);
  }
  for (let x = width - borderPx; x < width; x += 1) {
    for (let y = borderPx; y < height - borderPx; y += 1) sample(x, y);
  }
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = Math.floor(rs.length / 2);
  return { r: rs[mid] ?? 255, g: gs[mid] ?? 0, b: bs[mid] ?? 255 };
};

const FULL_ALPHA_THRESHOLD = 70;
const FADE_RANGE = 50;

const blobToWebP = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("toBlob returned null"));
      },
      "image/webp",
      0.92,
    );
  });

const sha256Hex = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Fetch the model's PNG, key the dominant background color out to
 * transparency, and re-encode as WebP. Returns the blob plus its
 * SHA-256 (needed for the R2 sigv4 PUT) and a previewable object URL.
 */
export const processSheetImage = async (
  imageUrl: string,
): Promise<EmojiSheetBlob> => {
  const bitmap = await loadImageBitmap(imageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const key = detectBorderColor(pixels, canvas.width, canvas.height, 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const dr = pixels[i]! - key.r;
    const dg = pixels[i + 1]! - key.g;
    const db = pixels[i + 2]! - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= FULL_ALPHA_THRESHOLD) {
      pixels[i + 3] = 0;
    } else if (dist <= FULL_ALPHA_THRESHOLD + FADE_RANGE) {
      const fade = (dist - FULL_ALPHA_THRESHOLD) / FADE_RANGE;
      pixels[i + 3] = Math.round(255 * fade);
    }
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await blobToWebP(canvas);
  const sha256 = await sha256Hex(blob);
  return {
    blob,
    sha256,
    objectUrl: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  };
};

export type EmojiPackUploadTarget = {
  key: string;
  publicUrl: string;
  putUrl: string;
  headers: Record<string, string>;
};

/**
 * PUT a sheet to its presigned R2 URL. Throws on non-2xx so the
 * caller can roll back the in-flight create.
 */
export const uploadSheetToR2 = async (
  blob: Blob,
  target: EmojiPackUploadTarget,
): Promise<void> => {
  const res = await fetch(target.putUrl, {
    method: "PUT",
    headers: target.headers,
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sheet upload failed (${res.status})${text ? `: ${text}` : ""}`);
  }
};

export type EmojiCoverBlob = {
  blob: Blob;
  sha256: string;
  objectUrl: string;
};

/**
 * Crop the chosen cover cell out of a generated sheet blob and re-encode
 * it as a tiny WebP. Stored in R2 alongside the full sheets so the
 * Store grid can render a single emoji without fetching the whole sheet.
 */
export const buildEmojiCoverBlob = async (
  sheetBlob: Blob,
  cell: number,
  outputSize = 96,
): Promise<EmojiCoverBlob> => {
  const bitmap = await createImageBitmap(sheetBlob);
  const cellWidth = bitmap.width / EMOJI_SHEET_GRID_SIZE;
  const cellHeight = bitmap.height / EMOJI_SHEET_GRID_SIZE;
  const row = Math.floor(cell / EMOJI_SHEET_GRID_SIZE);
  const col = cell % EMOJI_SHEET_GRID_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas2D unavailable for cover");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    col * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    0,
    0,
    outputSize,
    outputSize,
  );
  bitmap.close();
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error("cover toBlob returned null")),
      "image/webp",
      0.9,
    );
  });
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { blob, sha256, objectUrl: URL.createObjectURL(blob) };
};
