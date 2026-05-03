import { createServiceRequest } from "@/infra/http/service-request";
import type { UserPetUploadTarget } from "./user-pet-data";

export const USER_PET_ATLAS = {
  width: 2560,
  height: 3240,
  columns: 8,
  rows: 9,
  cellWidth: 320,
  cellHeight: 360,
  chroma: "#00ff00",
} as const;

export type UserPetSpritesheetBlob = {
  blob: Blob;
  sha256: string;
  objectUrl: string;
  width: number;
  height: number;
  warnings: string[];
};

export type SubmitUserPetJobResult = { jobId: string };

const MEDIA_GENERATE_PATH = "/api/media/v1/generate";

type RGB = { r: number; g: number; b: number };

const ROWS = [
  {
    state: "idle",
    intent:
      "ambient breathing loop spread across all eight cells. Subtle chest/head movement only; no walking or waving.",
  },
  {
    state: "running-right",
    intent:
      "facing right, scampering across all eight cells. Body and limbs in motion; no speed lines, dust, or shadows.",
  },
  {
    state: "running-left",
    intent:
      "facing left, scampering across all eight cells, mirrored from running-right when symmetric. No speed lines, dust, or shadows.",
  },
  {
    state: "waving",
    intent:
      "warm greeting paw wave spread across all eight cells. Convey through paw pose only; no wave marks, motion arcs, sparkles, or symbols.",
  },
  {
    state: "jumping",
    intent:
      "vertical hop arc spread across all eight cells. Convey through body position only; no shadows, dust, landing marks, or impact bursts.",
  },
  {
    state: "failed",
    intent:
      "dizzy, shocked, or shaken reaction across all eight cells. Attached opaque tears, stars, or smoke puffs may overlap the silhouette; no detached symbols.",
  },
  {
    state: "waiting",
    intent:
      "polite needs-input loop across all eight cells. Looking up, tapping, or glancing; no question marks or thought bubbles.",
  },
  {
    state: "success",
    intent:
      "happy celebratory loop across all eight cells. Use pose and face only; no confetti, sparkles, floating hearts, or detached props.",
  },
  {
    state: "review",
    intent:
      "focused review loop across all eight cells. Lean, blink, eye direction, head tilt, or paw position; no papers, code, UI, or punctuation.",
  },
] as const;

export const buildUserPetAtlasPrompt = (args: {
  name: string;
  description: string;
  style?: string;
}): string => {
  const rowsTable = ROWS.map(
    (row, index) => `| ${index} | ${row.state.padEnd(13)} | ${row.intent}`,
  ).join("\n");
  return `# Stella pet sprite atlas — ${args.name.trim() || "Custom Pet"}

Generate a single ${USER_PET_ATLAS.width} × ${USER_PET_ATLAS.height} sprite sheet of the same pet performing nine animation states.

## Layout

- The image is exactly ${USER_PET_ATLAS.width} × ${USER_PET_ATLAS.height} pixels.
- ${USER_PET_ATLAS.rows} rows × ${USER_PET_ATLAS.columns} columns of ${USER_PET_ATLAS.cellWidth} × ${USER_PET_ATLAS.cellHeight} cells.
- Every row contains exactly ${USER_PET_ATLAS.columns} frames. Frames within each row read left to right.
- Each pet silhouette fits fully inside its single cell with breathing room on all sides. No silhouette crosses into a neighboring cell.

## Rows

| row | state         | animation intent
| --- | ------------- | ----------------
${rowsTable}

## Pet identity

${args.description.trim() || "A friendly Stella mascot pet."}

Identity must stay consistent across every cell: same head shape, face, markings, palette, prop, outline weight, and body proportions.

## Style

Small pixel-art-adjacent mascot. Chunky readable silhouette. Thick dark 1-2 px outline. Visible stepped pixel edges. Limited palette. Flat cel shading. Simple expressive face. Tiny limbs.${args.style?.trim() ? `\n\nAdditional style notes: ${args.style.trim()}` : ""}

## Background

Background everywhere outside the pet silhouette is a single flat ${USER_PET_ATLAS.chroma} (true RGB, no gradient, no noise, no other green tones in the pet). The same ${USER_PET_ATLAS.chroma} fills the gutters between cells.

## Forbidden

- No detached effects, shadows, labels, frame numbers, captions, speech bubbles, thought bubbles, UI, code, punctuation marks, watermarks, or grid guidelines.
- No chroma-key-adjacent colors inside the pet, prop, or any allowed attached effect.
- No silhouette crossing into a neighboring cell. Scale the silhouette down when needed.`;
};

export const submitUserPetAtlasJob = async (args: {
  name: string;
  description: string;
  style?: string;
}): Promise<SubmitUserPetJobResult> => {
  const { endpoint, headers } = await createServiceRequest(
    MEDIA_GENERATE_PATH,
    { "Content-Type": "application/json" },
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      capability: "text_to_image",
      profile: "best",
      prompt: buildUserPetAtlasPrompt(args),
      input: {
        image_size: {
          width: USER_PET_ATLAS.width,
          height: USER_PET_ATLAS.height,
        },
        quality: "low",
        output_format: "png",
      },
    }),
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
  return { r: rs[mid] ?? 0, g: gs[mid] ?? 255, b: bs[mid] ?? 0 };
};

const FULL_ALPHA_THRESHOLD = 70;
const FADE_RANGE = 50;

const keyBackgroundToAlpha = (
  imageData: ImageData,
  warnings: string[],
): void => {
  const pixels = imageData.data;
  const key = detectBorderColor(pixels, imageData.width, imageData.height, 6);
  const expected = { r: 0, g: 255, b: 0 };
  const drift =
    Math.abs(key.r - expected.r) +
    Math.abs(key.g - expected.g) +
    Math.abs(key.b - expected.b);
  if (drift > 30) {
    warnings.push(
      `Detected chroma key rgb(${key.r}, ${key.g}, ${key.b}) instead of ${USER_PET_ATLAS.chroma}.`,
    );
  }
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
};

const validateCells = (ctx: CanvasRenderingContext2D): string[] => {
  const warnings: string[] = [];
  for (let row = 0; row < USER_PET_ATLAS.rows; row += 1) {
    for (let col = 0; col < USER_PET_ATLAS.columns; col += 1) {
      const data = ctx.getImageData(
        col * USER_PET_ATLAS.cellWidth,
        row * USER_PET_ATLAS.cellHeight,
        USER_PET_ATLAS.cellWidth,
        USER_PET_ATLAS.cellHeight,
      ).data;
      let opaquePixels = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i]! > 24) opaquePixels += 1;
      }
      if (opaquePixels < 64) {
        warnings.push(`Cell ${row + 1}:${col + 1} appears empty.`);
      }
    }
  }
  return warnings;
};

const blobToWebP = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
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

export const processUserPetAtlasImage = async (
  imageUrl: string,
): Promise<UserPetSpritesheetBlob> => {
  const warnings: string[] = [];
  const bitmap = await loadImageBitmap(imageUrl);
  if (
    bitmap.width !== USER_PET_ATLAS.width ||
    bitmap.height !== USER_PET_ATLAS.height
  ) {
    warnings.push(
      `Generated atlas was ${bitmap.width}x${bitmap.height}; resized to ${USER_PET_ATLAS.width}x${USER_PET_ATLAS.height}.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = USER_PET_ATLAS.width;
  canvas.height = USER_PET_ATLAS.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas2D unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  keyBackgroundToAlpha(imageData, warnings);
  ctx.putImageData(imageData, 0, 0);
  warnings.push(...validateCells(ctx));

  const blob = await blobToWebP(canvas);
  const sha256 = await sha256Hex(blob);
  return {
    blob,
    sha256,
    objectUrl: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
    warnings,
  };
};

export const uploadUserPetSpritesheetToR2 = async (
  blob: Blob,
  target: UserPetUploadTarget,
): Promise<void> => {
  const res = await fetch(target.putUrl, {
    method: "PUT",
    headers: target.headers,
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Pet upload failed (${res.status})${text ? `: ${text}` : ""}`,
    );
  }
};
