"use node";

import { createHmac, randomUUID, createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "../_generated/server";
import { requireConnectedUserIdAction } from "../auth";
import {
  RATE_STANDARD,
  enforceActionRateLimit,
} from "../lib/rate_limits";
import { requireBoundedString } from "../shared_validators";

const DEFAULT_BUCKET = "stella-emotes";
const DEFAULT_PREFIX = "emoji-packs";
const DEFAULT_PUBLIC_BASE =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
const MAX_PACK_ID = 64;
const PACK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const uploadTargetValidator = v.object({
  key: v.string(),
  publicUrl: v.string(),
  putUrl: v.string(),
  headers: v.record(v.string(), v.string()),
});

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConvexError({
      code: "SERVER_MISCONFIGURED",
      message: `Missing ${name} for emoji pack uploads.`,
    });
  }
  return value;
};

const normalizePackId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packId", MAX_PACK_ID);
  if (!PACK_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Pack ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeSha256 = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a SHA-256 hex digest.`,
    });
  }
  return normalized;
};

const normalizePrefix = (value: string | undefined): string =>
  (value?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

const signR2Put = (args: {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  key: string;
  payloadHash: string;
  contentType: string;
  cacheControl: string;
}): {
  putUrl: string;
  headers: {
    host: string;
    "x-amz-content-sha256": string;
    "x-amz-date": string;
    "content-type": string;
    "cache-control": string;
    authorization: string;
  };
} => {
  const url = new URL(
    `${args.endpoint.replace(/\/+$/, "")}/${args.bucket}/${args.key}`,
  );
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now
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

export const createUploadUrls = action({
  args: {
    packId: v.string(),
    sheet1Sha256: v.string(),
    sheet2Sha256: v.string(),
    coverSha256: v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    uploadId: v.string(),
    sheet1: uploadTargetValidator,
    sheet2: uploadTargetValidator,
    cover: v.optional(uploadTargetValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "emojiPacks.createUploadUrls",
      ownerId,
      RATE_STANDARD,
    );
    const packId = normalizePackId(args.packId);
    const contentType = args.contentType?.trim() || "image/webp";
    if (contentType !== "image/webp") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Emoji pack sheets must be uploaded as image/webp.",
      });
    }
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
    const endpoint = requireEnv("R2_ENDPOINT");
    const bucket = process.env.R2_EMOJI_BUCKET?.trim()
      || process.env.R2_PETS_BUCKET?.trim()
      || DEFAULT_BUCKET;
    const prefix = normalizePrefix(process.env.R2_EMOJI_PREFIX);
    const publicBase = (
      process.env.R2_PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE
    ).replace(/\/+$/, "");
    const uploadId = randomUUID();
    const ownerKey = sha256Hex(ownerId).slice(0, 24);
    const baseKey = `${prefix}/${ownerKey}/${packId}/${uploadId}`;
    const sheet1Sha256 = normalizeSha256(args.sheet1Sha256, "sheet1Sha256");
    const sheet2Sha256 = normalizeSha256(args.sheet2Sha256, "sheet2Sha256");
    const coverSha256 = args.coverSha256
      ? normalizeSha256(args.coverSha256, "coverSha256")
      : undefined;
    const makeTarget = (filename: string, payloadHash: string) => {
      const key = `${baseKey}/${filename}`;
      const signed = signR2Put({
        accessKeyId,
        secretAccessKey,
        endpoint,
        bucket,
        key,
        payloadHash,
        contentType,
        cacheControl: CACHE_CONTROL,
      });
      return {
        key,
        publicUrl: `${publicBase}/${key}`,
        putUrl: signed.putUrl,
        headers: signed.headers,
      };
    };
    const cover = coverSha256
      ? makeTarget("cover.webp", coverSha256)
      : undefined;
    return {
      uploadId,
      sheet1: makeTarget("sheet-1.webp", sheet1Sha256),
      sheet2: makeTarget("sheet-2.webp", sheet2Sha256),
      ...(cover ? { cover } : {}),
    };
  },
});
