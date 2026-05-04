#!/usr/bin/env bun
/**
 * Build a single emoji sprite sheet by hitting the Stella media gateway.
 *
 * Submits a `text_to_image` job (profile: `best` → `openai/gpt-image-2`) at
 * 512×512 with quality `low`, asking the model to lay out the 64 emojis from
 * `cells.ts` on an 8×8 grid over a magenta background. After download we
 * key the magenta out to transparency and save the result as a WebP under
 * `desktop/public/emoji-sprites/sheet-{N}.webp`. The renderer slices that
 * sheet at draw time via CSS `background-position`, so we never split the
 * image into 64 files on disk.
 *
 * The auth path is the gateway's `MEDIA_PUBLIC_TEST_MODE` switch — the
 * Convex deployment must have `MEDIA_PUBLIC_TEST_MODE=1` for this script
 * to bypass user auth.
 *
 * Usage:
 *   bun run emoji-sprite:gen -- --sheet 1
 *   bun run emoji-sprite:gen -- --sheet 2 --style "neon synthwave"
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { EMOJI_SHEETS } from "../src/app/chat/emoji-sprites/cells.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(HERE, "..");
const PUBLIC_SPRITES_DIR = path.join(DESKTOP_ROOT, "public", "emoji-sprites");
/**
 * Non-public scratch dir for the original generator output and the
 * post-key preview PNG. Kept outside `public/` so neither ships with
 * the renderer bundle.
 */
const DEBUG_SPRITES_DIR = path.join(
  DESKTOP_ROOT,
  ".emoji-sprites-debug",
);

const SITE_URL = (
  process.env.STELLA_SITE_URL ?? "https://impartial-crab-34.convex.site"
).replace(/\/+$/, "");
const CONVEX_URL = (
  process.env.STELLA_CONVEX_URL ?? "https://impartial-crab-34.convex.cloud"
).replace(/\/+$/, "");

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const buildPrompt = (sheetIndex: number, style: string): string => {
  const list = EMOJI_SHEETS[sheetIndex];
  if (!list) throw new Error(`Unknown sheet index ${sheetIndex}`);
  const theme = style.trim();
  const cellLines = list
    .map((glyph, idx) => {
      const row = Math.floor(idx / 8) + 1;
      const col = (idx % 8) + 1;
      return `- r${row}c${col}: ${glyph}`;
    })
    .join("\n");
  return [
    `Design a custom emoji pack styled entirely as: "${theme}".`,
    "The style is the most important constraint. Every single emoji must be a fully original artwork drawn in that style — never the default Apple, Google, Microsoft, Samsung, Twemoji, or system emoji rendering. If a stock emoji shape would appear, you have failed; redraw it from scratch in the requested style.",
    `Theme reminder: "${theme}". Apply it to every cell — the linework, palette, shading, mood, and character design must all read as that theme. Subtle reskins are not enough; the pack should be unmistakably this style.`,
    "",
    "Each grid cell below names a concept the cell should depict, written as a reference glyph. Treat the glyph as a concept hint only — reinterpret it as a brand-new icon in the requested style, matching the same meaning. Faces become characters in this style; hands become hands in this style; objects become objects in this style.",
    "",
    "Cells (row-major, 8 rows × 8 columns):",
    cellLines,
    "",
    "Layout:",
    "- Output a single square image as an 8×8 grid of cells.",
    "- Cells are perfectly uniform in size with consistent padding.",
    "- Each icon is fully contained inside its cell, centered, with breathing room.",
    "- Render in the exact row-major order above. r1c1 is the top-left cell; r8c8 is the bottom-right.",
    "",
    "Background:",
    "- Fill every non-icon pixel with a single uniform solid magenta. Same exact shade everywhere — no gradient, no texture, no shading.",
    "- The same magenta fills the gutters between cells.",
    "",
    "Forbidden:",
    "- Default platform emoji rendering of any kind. No Apple/Google/Microsoft/Samsung/Twemoji glyph reuse, even as a base.",
    "- Borders, frame lines, grid lines, labels, captions, watermarks, signatures, or text anywhere on the canvas.",
    "- Decorative confetti, sparkles, particles, motion lines, or background props that do not belong to the icon itself.",
    "- Icons crossing into neighboring cells.",
  ].join("\n");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const submitJob = async (prompt: string): Promise<string> => {
  const body = {
    capability: "text_to_image",
    profile: "best",
    prompt,
    input: {
      image_size: { width: 512, height: 512 },
      quality: "medium",
      output_format: "png",
    },
  };
  const url = `${SITE_URL}/api/media/v1/generate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Submit failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { jobId?: string };
  if (!json.jobId) throw new Error("Submit response missing jobId");
  return json.jobId;
};

type MediaJobSnapshot = {
  status?: string;
  output?: { images?: Array<{ url?: string }> } | null;
  error?: { message?: string } | null;
};

const pollJob = async (jobId: string): Promise<string> => {
  const client = new ConvexHttpClient(CONVEX_URL);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Polling timed out for job ${jobId}`);
    }
    const job = (await client.query(anyApi.media_jobs.getByJobId, { jobId })) as
      | MediaJobSnapshot
      | null;
    if (job?.status === "succeeded") {
      const url = job.output?.images?.[0]?.url;
      if (!url) throw new Error("Job succeeded but no image URL was returned");
      return url;
    }
    if (job?.status === "failed" || job?.status === "canceled") {
      throw new Error(`Job ${job.status}: ${job.error?.message ?? "unknown"}`);
    }
    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }
};

const downloadImage = async (url: string): Promise<Buffer> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Sample the median RGB of a thin border strip around the image. The image
 * generator paints whatever shade of pink/magenta it likes, so we don't
 * hardcode `(255, 0, 255)` — we infer the actual background color from the
 * pixels closest to the edges and key against that. Median (rather than
 * mean) shrugs off the occasional confetti speck or stray glyph pixel that
 * lands near the border.
 */
const detectBackgroundColor = (
  pixels: Buffer,
  width: number,
  height: number,
  borderPx: number,
): { r: number; g: number; b: number } => {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sample = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    rs.push(pixels[idx]!);
    gs.push(pixels[idx + 1]!);
    bs.push(pixels[idx + 2]!);
  };
  for (let y = 0; y < borderPx; y++) {
    for (let x = 0; x < width; x++) sample(x, y);
  }
  for (let y = height - borderPx; y < height; y++) {
    for (let x = 0; x < width; x++) sample(x, y);
  }
  for (let x = 0; x < borderPx; x++) {
    for (let y = borderPx; y < height - borderPx; y++) sample(x, y);
  }
  for (let x = width - borderPx; x < width; x++) {
    for (let y = borderPx; y < height - borderPx; y++) sample(x, y);
  }
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = Math.floor(rs.length / 2);
  return { r: rs[mid]!, g: gs[mid]!, b: bs[mid]! };
};

/**
 * Key the dominant background color out to transparency.
 *
 * Two-band alpha: distance from the detected key color below
 * `fullAlphaThreshold` goes fully transparent; distances inside
 * `fadeRange` fade linearly so anti-aliased emoji edges feather cleanly
 * instead of leaving a hard halo. Bumps to `fullAlphaThreshold` make the
 * cut more aggressive (more pixels go transparent); bumps to `fadeRange`
 * widen the soft edge.
 */
const keyBackgroundToTransparent = async (
  inputPng: Buffer,
  opts: { fullAlphaThreshold: number; fadeRange: number },
): Promise<{ webp: Buffer; key: { r: number; g: number; b: number } }> => {
  const { data, info } = await sharp(inputPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("Expected RGBA pixels");
  const pixels = Buffer.from(data);
  const key = detectBackgroundColor(pixels, info.width, info.height, 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const dr = pixels[i]! - key.r;
    const dg = pixels[i + 1]! - key.g;
    const db = pixels[i + 2]! - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= opts.fullAlphaThreshold) {
      pixels[i + 3] = 0;
    } else if (dist <= opts.fullAlphaThreshold + opts.fadeRange) {
      const fade = (dist - opts.fullAlphaThreshold) / opts.fadeRange;
      pixels[i + 3] = Math.round(255 * fade);
    }
  }
  const webp = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .webp({ quality: 92, alphaQuality: 100 })
    .toBuffer();
  return { webp, key };
};

const main = async () => {
  const args = process.argv.slice(2);
  let sheetIndex = -1;
  let style = "party style";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--sheet") {
      const value = args[++i];
      if (!value) throw new Error("--sheet requires a value (1 or 2)");
      sheetIndex = parseInt(value, 10) - 1;
    } else if (flag === "--style") {
      const value = args[++i];
      if (!value) throw new Error("--style requires a value");
      style = value;
    }
  }
  if (
    !Number.isFinite(sheetIndex) ||
    sheetIndex < 0 ||
    sheetIndex >= EMOJI_SHEETS.length
  ) {
    console.error(
      `Usage: bun run scripts/generate-emoji-sprite.ts --sheet <1|2> [--style "..."]`,
    );
    process.exit(1);
  }

  await fs.mkdir(PUBLIC_SPRITES_DIR, { recursive: true });
  await fs.mkdir(DEBUG_SPRITES_DIR, { recursive: true });

  const prompt = buildPrompt(sheetIndex, style);
  console.log(`[gen] sheet ${sheetIndex + 1}`);
  console.log(`[gen] style: ${style}`);
  console.log(`[gen] prompt:\n${prompt}\n`);

  console.log(`[gen] submitting to ${SITE_URL}/api/media/v1/generate …`);
  const jobId = await submitJob(prompt);
  console.log(`[gen] jobId=${jobId}`);

  console.log(`[gen] polling ${CONVEX_URL} `);
  const imageUrl = await pollJob(jobId);
  console.log(`\n[gen] image: ${imageUrl}`);

  console.log(`[gen] downloading…`);
  const png = await downloadImage(imageUrl);
  const rawPath = path.join(
    DEBUG_SPRITES_DIR,
    `sheet-${sheetIndex + 1}.raw.png`,
  );
  await fs.writeFile(rawPath, png);
  console.log(`[gen] saved raw → ${rawPath}`);

  console.log(`[gen] keying background → transparent…`);
  const { webp, key } = await keyBackgroundToTransparent(png, {
    fullAlphaThreshold: 70,
    fadeRange: 50,
  });
  console.log(
    `[gen] detected background color: rgb(${key.r}, ${key.g}, ${key.b})`,
  );
  const sheetPath = path.join(
    PUBLIC_SPRITES_DIR,
    `sheet-${sheetIndex + 1}.webp`,
  );
  await fs.writeFile(sheetPath, webp);
  console.log(`[gen] wrote ${sheetPath} (${webp.length} bytes)`);

  // Write a transparent-PNG preview alongside the raw output so the
  // result is easy to eyeball without WebP-aware tooling.
  const previewPath = path.join(
    DEBUG_SPRITES_DIR,
    `sheet-${sheetIndex + 1}.preview.png`,
  );
  const previewPng = await sharp(webp).png().toBuffer();
  await fs.writeFile(previewPath, previewPng);
  console.log(`[gen] saved preview → ${previewPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
