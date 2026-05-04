"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { resolveManagedModelConfigs } from "../agent/model_resolver";
import { scheduleManagedUsage } from "../lib/managed_billing";
import { extractJsonBlock } from "../lib/json";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";
import { requireBoundedString } from "../shared_validators";
import { isBlockedContentTag } from "../lib/content_tags";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TAGS = 8;
const MAX_TAG = 32;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 500;

type GeneratedAssetMetadata = {
  displayName?: string;
  description?: string;
  tags: string[];
};

const ASSET_METADATA_SYSTEM_PROMPT = [
  "You name and categorize Stella Store visual assets.",
  "Study the attached generated image(s) and the creator's prompt/context.",
  "Return only JSON. No markdown.",
  "Prefer short, friendly names. Descriptions should be one Store-card sentence.",
  "Tags should be lowercase, user-facing filter labels like cute, pixel, animal, cozy, fantasy, food, robot, spooky, pastel, neon, object, emoji, pet.",
  "Never use nsfw as a tag or category.",
].join("\n");

const ASSET_METADATA_OUTPUT_INSTRUCTIONS = [
  "Return this JSON object:",
  "{",
  '  "displayName": "2-5 words, Title Case",',
  '  "description": "80-160 character Store description",',
  '  "tags": ["3-6 lowercase tags"]',
  "}",
].join("\n");

const normalizeOptionalText = (
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeTag = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG);
  return normalized.length > 0 ? normalized : null;
};

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tag = normalizeTag(raw);
    if (!tag || isBlockedContentTag(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
};

const parseMetadata = (text: string): GeneratedAssetMetadata => {
  const parsed = extractJsonBlock(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConvexError({
      code: "METADATA_GENERATION_FAILED",
      message: "The model did not return valid metadata JSON.",
    });
  }
  const record = parsed as Record<string, unknown>;
  return {
    displayName: normalizeOptionalText(
      record.displayName,
      "displayName",
      MAX_DISPLAY_NAME,
    ),
    description: normalizeOptionalText(
      record.description,
      "description",
      MAX_DESCRIPTION,
    ),
    tags: normalizeTags(record.tags),
  };
};

const buildSearchText = (args: {
  displayName: string;
  description?: string;
  prompt?: string;
  authorDisplayName?: string;
  tags: string[];
}): string =>
  [
    args.displayName,
    args.description ?? "",
    args.prompt ?? "",
    args.authorDisplayName ?? "",
    ...args.tags,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const fetchImage = async (
  url: string,
): Promise<{ mimeType: string; data: string }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ConvexError({
      code: "METADATA_IMAGE_FETCH_FAILED",
      message: "Could not inspect the generated Store image.",
    });
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0] ??
    "image/webp";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ConvexError({
      code: "METADATA_IMAGE_TOO_LARGE",
      message: "Generated Store image is too large to inspect.",
    });
  }
  return {
    mimeType,
    data: Buffer.from(bytes).toString("base64"),
  };
};

const generateMetadata = async (
  ctx: Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">,
  args: {
    ownerId: string;
    assetKind: "pet" | "emoji_pack";
    prompt?: string;
    currentDisplayName?: string;
    currentDescription?: string;
    imageUrls: string[];
  },
): Promise<GeneratedAssetMetadata> => {
  const { config, fallbackConfig } = await resolveManagedModelConfigs(
    ctx,
    "store_asset_metadata",
    args.ownerId,
  );
  const images = await Promise.all(args.imageUrls.map(fetchImage));
  const startedAt = Date.now();
  const message = await completeManagedChat({
    config,
    fallbackConfig,
    context: {
      systemPrompt: ASSET_METADATA_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              ASSET_METADATA_OUTPUT_INSTRUCTIONS,
              "",
              `Asset kind: ${args.assetKind}`,
              args.currentDisplayName
                ? `Creator-provided name: ${args.currentDisplayName}`
                : "",
              args.currentDescription
                ? `Creator-provided description: ${args.currentDescription}`
                : "",
              args.prompt ? `Creator prompt/style notes: ${args.prompt}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          ...images.map((image) => ({
            type: "image" as const,
            mimeType: image.mimeType,
            data: image.data,
          })),
        ],
        timestamp: Date.now(),
      }],
    },
  });
  await scheduleManagedUsage(ctx, {
    ownerId: args.ownerId,
    agentType: "service:store_asset_metadata",
    model: message.model,
    durationMs: Date.now() - startedAt,
    success: true,
    usage: usageSummaryFromAssistant(message),
  });
  return parseMetadata(assistantText(message));
};

export const enrichUserPet = internalAction({
  args: { petId: v.id("user_pets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: Doc<"user_pets"> | null = await ctx.runQuery(
      internal.data.user_pets.getByIdInternal,
      { petId: args.petId },
    );
    if (!row) return null;
    const metadata = await generateMetadata(ctx, {
      ownerId: row.ownerId,
      assetKind: "pet",
      currentDisplayName: row.displayName,
      currentDescription: row.description,
      prompt: row.prompt,
      imageUrls: [row.previewUrl ?? row.spritesheetUrl],
    });
    const displayName = metadata.displayName ?? row.displayName;
    const description = metadata.description ?? row.description;
    await ctx.runMutation(internal.data.user_pets.patchGeneratedMetadata, {
      petId: args.petId,
      metadata: {
        displayName,
        description,
        tags: metadata.tags,
        searchText: buildSearchText({
          displayName,
          description,
          prompt: row.prompt,
          authorDisplayName: row.authorDisplayName,
          tags: metadata.tags,
        }),
        updatedAt: Date.now(),
      },
    });
    return null;
  },
});

export const enrichEmojiPack = internalAction({
  args: { packId: v.id("emoji_packs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: Doc<"emoji_packs"> | null = await ctx.runQuery(
      internal.data.emoji_packs.getByIdInternal,
      { packId: args.packId },
    );
    if (!row) return null;
    const metadata = await generateMetadata(ctx, {
      ownerId: row.ownerId,
      assetKind: "emoji_pack",
      currentDisplayName: row.displayName,
      currentDescription: row.description,
      prompt: row.prompt,
      imageUrls: [
        row.coverUrl ?? row.sheet1Url,
        row.sheet1Url,
        row.sheet2Url,
      ],
    });
    const displayName = metadata.displayName ?? row.displayName;
    const description = metadata.description ?? row.description;
    await ctx.runMutation(
      internal.data.emoji_packs.patchGeneratedMetadata,
      {
        packId: args.packId,
        metadata: {
          displayName,
          ...(description ? { description } : {}),
          tags: metadata.tags,
          searchText: buildSearchText({
            displayName,
            description,
            prompt: row.prompt,
            authorDisplayName: row.authorDisplayName,
            tags: metadata.tags,
          }),
          updatedAt: Date.now(),
        },
      },
    );
    return null;
  },
});
