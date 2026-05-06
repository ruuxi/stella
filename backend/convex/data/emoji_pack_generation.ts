"use node";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireConnectedUserIdAction } from "../auth";
import { getFalApiKey, submitFalRequest, fetchFalResultPayload } from "../media_fal_webhooks";
import {
  RATE_STANDARD,
  enforceActionRateLimit,
} from "../lib/rate_limits";
import { emoji_pack_validator, emoji_pack_visibility_validator } from "../schema/emoji_packs";
import { requireBoundedString } from "../shared_validators";
import {
  EMOJI_SHEETS,
  EMOJI_SHEET_GRID_SIZE,
} from "./emoji_pack_grid_constants";

const DEFAULT_BUCKET = "stella-emotes";
const DEFAULT_PREFIX = "emoji-packs";
const DEFAULT_PUBLIC_BASE =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
const DEFAULT_STYLE = "playful party style";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const FAL_ENDPOINT_ID = "openai/gpt-image-2";
const SHEET_SIZE = 768;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 6 * 60_000;
const MAX_PROMPT = 2_000;

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for emoji pack generation.`,
    });
  }
  return value;
};

const normalizePrefix = (value: string | undefined): string =>
  (value?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");

const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const buildPackId = (prompt: string): string => {
  const slug = slugify(prompt) || "emoji-pack";
  return `${slug}-${Date.now().toString(36).slice(-6)}`;
};

const buildSheetPrompt = (sheetIndex: number, style: string): string => {
  const list = EMOJI_SHEETS[sheetIndex];
  if (!list) throw new Error(`Unknown sheet index ${sheetIndex}`);
  const theme = style.trim() || DEFAULT_STYLE;
  const cellLines = list
    .map((glyph, idx) => {
      const row = Math.floor(idx / EMOJI_SHEET_GRID_SIZE) + 1;
      const col = (idx % EMOJI_SHEET_GRID_SIZE) + 1;
      return `- r${row}c${col}: ${glyph}`;
    })
    .join("\n");
  return [
    `Design a custom emoji pack styled entirely as: "${theme}".`,
    "The style is the most important constraint. Every single emoji must be fully original artwork drawn in that style, never default Apple, Google, Microsoft, Samsung, Twemoji, or system emoji rendering.",
    `Theme reminder: "${theme}". Apply it to every cell: linework, palette, shading, mood, and character design must all read as that theme.`,
    "",
    "Each grid cell below names a concept the cell should depict, written as a reference glyph. Treat the glyph as a concept hint only and reinterpret it as a brand-new icon with the same meaning.",
    "",
    "Cells (row-major, 6 rows x 6 columns):",
    cellLines,
    "",
    "Layout:",
    "- Output a single square image as a 6x6 grid of cells.",
    "- Cells are perfectly uniform in size with consistent padding.",
    "- Each icon is fully contained inside its cell, centered, with breathing room.",
    "- Render in the exact row-major order above. r1c1 is the top-left cell; r6c6 is the bottom-right.",
    "",
    "Background:",
    "- Use a fully transparent background for every non-icon pixel.",
    "- The gutters between cells must also be fully transparent.",
    "",
    "Forbidden:",
    "- Default platform emoji rendering of any kind.",
    "- Borders, frame lines, grid lines, labels, captions, watermarks, signatures, or text anywhere on the canvas.",
    "- Decorative confetti, sparkles, particles, motion lines, or background props that do not belong to the icon itself.",
    "- Icons crossing into neighboring cells.",
  ].join("\n");
};

const extractFirstImageUrl = (output: unknown): string | null => {
  if (!output || typeof output !== "object") return null;
  const images = (output as { images?: Array<{ url?: unknown }> }).images;
  if (!Array.isArray(images)) return null;
  for (const entry of images) {
    if (entry && typeof entry.url === "string" && entry.url.length > 0) {
      return entry.url;
    }
  }
  return null;
};

const pollFalImageUrl = async (args: {
  apiKey: string;
  responseUrl: string;
}): Promise<string> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const output = await fetchFalResultPayload({
        apiKey: args.apiKey,
        url: args.responseUrl,
      });
      const imageUrl = extractFirstImageUrl(output);
      if (imageUrl) return imageUrl;
      lastError = "Fal result did not include an image URL.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Fal result was not ready.";
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(lastError || "Timed out waiting for emoji sheet generation.");
};

const submitSheet = async (args: {
  apiKey: string;
  webhookUrl: string;
  sheetIndex: number;
  style: string;
}): Promise<string> => {
  const submitted = await submitFalRequest({
    apiKey: args.apiKey,
    endpointId: FAL_ENDPOINT_ID,
    webhookUrl: args.webhookUrl,
    input: {
      prompt: buildSheetPrompt(args.sheetIndex, args.style),
      image_size: { width: SHEET_SIZE, height: SHEET_SIZE },
      quality: "medium",
      output_format: "webp",
    },
  });
  const responseUrl =
    submitted.responseUrl ??
    `https://queue.fal.run/${FAL_ENDPOINT_ID}/requests/${submitted.requestId}`;
  return await pollFalImageUrl({ apiKey: args.apiKey, responseUrl });
};

const downloadImage = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const signR2Put = (args: {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  key: string;
  payloadHash: string;
  contentType: string;
  cacheControl: string;
}): { putUrl: string; headers: Record<string, string> } => {
  const url = new URL(
    `${args.endpoint.replace(/\/+$/, "")}/${args.bucket}/${args.key}`,
  );
  const region = "auto";
  const service = "s3";
  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const headersToSign = {
    host: url.host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
    "content-type": args.contentType,
    "cache-control": args.cacheControl,
  };
  const signedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    signedHeaderKeys
      .map((key) => `${key}:${headersToSign[key as keyof typeof headersToSign].trim()}`)
      .join("\n") + "\n";
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    putUrl: url.toString(),
    headers: {
      ...headersToSign,
      authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

const uploadR2Object = async (args: {
  key: string;
  bytes: Buffer;
  r2: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
  };
}): Promise<void> => {
  const signed = signR2Put({
    ...args.r2,
    key: args.key,
    payloadHash: sha256Hex(args.bytes),
    contentType: "image/webp",
    cacheControl: CACHE_CONTROL,
  });
  const response = await fetch(signed.putUrl, {
    method: "PUT",
    headers: signed.headers,
    body: new Uint8Array(args.bytes),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`R2 upload failed (${response.status})${text ? `: ${text}` : ""}`);
  }
};

export const generatePack = action({
  args: {
    prompt: v.string(),
    visibility: emoji_pack_visibility_validator,
  },
  returns: emoji_pack_validator,
  handler: async (ctx, args): Promise<Doc<"emoji_packs">> => {
    const ownerId = await requireConnectedUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "emojiPacks.generatePack",
      ownerId,
      RATE_STANDARD,
    );
    const prompt = args.prompt.trim();
    requireBoundedString(prompt, "prompt", MAX_PROMPT);
    if (!prompt) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Prompt is required.",
      });
    }
    const apiKey = getFalApiKey();
    if (!apiKey) {
      throw new ConvexError({
        code: "SERVER_MISCONFIGURED",
        message: "Media generation is not configured yet.",
      });
    }
    const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/+$/, "");
    const webhookUrl = `${siteUrl}/api/media/v1/webhooks/fal?jobId=${encodeURIComponent(`emoji-pack-${randomUUID()}`)}`;
    const r2 = {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      endpoint: requireEnv("R2_ENDPOINT"),
      bucket:
        process.env.R2_EMOJI_BUCKET?.trim() ||
        process.env.R2_PETS_BUCKET?.trim() ||
        DEFAULT_BUCKET,
    };
    const prefix = normalizePrefix(process.env.R2_EMOJI_PREFIX);
    const publicBase = (
      process.env.R2_PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE
    ).replace(/\/+$/, "");
    const packId = buildPackId(prompt);
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const uploadId = randomUUID();
    const baseKey = `${prefix}/${ownerKey}/${packId}/${uploadId}`;

    const imageUrls = await Promise.all(
      EMOJI_SHEETS.map((_, sheetIndex) =>
        submitSheet({ apiKey, webhookUrl, sheetIndex, style: prompt }),
      ),
    );
    const sheetBuffers = await Promise.all(
      imageUrls.map((url) => downloadImage(url)),
    );
    const sheetUrls = sheetBuffers.map((_, index) => {
      const key = `${baseKey}/sheet-${index + 1}.webp`;
      return `${publicBase}/${key}`;
    });

    await Promise.all(
      sheetBuffers.map((bytes, index) =>
        uploadR2Object({
          key: `${baseKey}/sheet-${index + 1}.webp`,
          bytes,
          r2,
        }),
      ),
    );

    return await ctx.runMutation(internal.data.emoji_packs.createGeneratedPack, {
      ownerId,
      packId,
      displayName: "Stella emoji pack",
      prompt,
      coverEmoji: EMOJI_SHEETS[0]![0]!,
      sheetUrls,
      visibility: args.visibility,
    });
  },
});
