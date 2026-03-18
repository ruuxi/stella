import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  getActiveSecretKeyVersion,
  rotateSecretToActiveKey,
} from "./secrets_crypto";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

const normalizeBatchSize = (batchSize?: number) => {
  if (!Number.isFinite(batchSize)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(batchSize as number)));
};

const shouldRotateByVersion = (
  currentVersion: number | undefined,
  activeVersion: number,
) => typeof currentVersion !== "number" || currentVersion !== activeVersion;

export const rotateEncryptedMaterialBatch = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const activeKeyVersion = getActiveSecretKeyVersion();
    const batchSize = normalizeBatchSize(args.batchSize);
    const now = Date.now();

    let rotated = 0;
    let failed = 0;
    let skipped = 0;

    let remaining = batchSize;

    if (remaining > 0) {
      // Query secrets NOT on the active key version.
      // Secrets with no keyVersion (undefined) sort before numeric values in the index,
      // so we query for keyVersion < activeKeyVersion and keyVersion > activeKeyVersion separately.
      const candidatesBelow = await ctx.db
        .query("secrets")
        .withIndex("by_keyVersion", (q) => q.lt("keyVersion", activeKeyVersion))
        .take(remaining);
      const candidatesAbove = await ctx.db
        .query("secrets")
        .withIndex("by_keyVersion", (q) => q.gt("keyVersion", activeKeyVersion))
        .take(remaining);
      const candidates = [...candidatesBelow, ...candidatesAbove];

      const rotationPromises = candidates.slice(0, remaining).map(async (candidate) => {
        try {
          const result = await rotateSecretToActiveKey(candidate.encryptedValue);
          if (!result.changed) {
            return { type: 'skipped' as const };
          }
          await ctx.db.patch(candidate._id, {
            encryptedValue: result.serialized,
            keyVersion: result.keyVersion,
            updatedAt: now,
          });
          return { type: 'rotated' as const };
        } catch {
          return { type: 'failed' as const };
        }
      });

      const results = await Promise.all(rotationPromises);
      for (const res of results) {
        if (res.type === 'skipped') skipped += 1;
        if (res.type === 'rotated') { rotated += 1; remaining -= 1; }
        if (res.type === 'failed') failed += 1;
      }
    }

    if (remaining > 0) {
      // Query slack installations NOT on the active key version.
      const candidatesBelow = await ctx.db
        .query("slack_installations")
        .withIndex("by_botTokenKeyVersion", (q) => q.lt("botTokenKeyVersion", activeKeyVersion))
        .take(remaining);
      const candidatesAbove = await ctx.db
        .query("slack_installations")
        .withIndex("by_botTokenKeyVersion", (q) => q.gt("botTokenKeyVersion", activeKeyVersion))
        .take(remaining);
      const candidates = [...candidatesBelow, ...candidatesAbove];

      const rotationPromises = candidates.slice(0, remaining).map(async (candidate) => {
        try {
          const result = await rotateSecretToActiveKey(candidate.botToken);
          if (!result.changed) {
            return { type: 'skipped' as const };
          }
          await ctx.db.patch(candidate._id, {
            botToken: result.serialized,
            botTokenKeyVersion: result.keyVersion,
            updatedAt: now,
          });
          return { type: 'rotated' as const };
        } catch {
          return { type: 'failed' as const };
        }
      });

      const results = await Promise.all(rotationPromises);
      for (const res of results) {
        if (res.type === 'skipped') skipped += 1;
        if (res.type === 'rotated') { rotated += 1; remaining -= 1; }
        if (res.type === 'failed') failed += 1;
      }
    }

    return {
      activeKeyVersion,
      batchSize,
      rotated,
      failed,
      skipped,
      hasMoreCandidates: remaining === 0,
    };
  },
});

export const rotateEncryptedMaterial = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxBatches = Number.isFinite(args.maxBatches)
      ? Math.max(1, Math.min(50, Math.floor(args.maxBatches as number)))
      : 5;
    const batchSize = normalizeBatchSize(args.batchSize);

    let totalRotated = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let activeKeyVersion = getActiveSecretKeyVersion();

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const batch = await ctx.runMutation(
        internal.data.secrets_rotation.rotateEncryptedMaterialBatch,
        { batchSize },
      );

      activeKeyVersion = batch.activeKeyVersion;
      totalRotated += batch.rotated;
      totalFailed += batch.failed;
      totalSkipped += batch.skipped;

      if (!batch.hasMoreCandidates || batch.rotated === 0) {
        break;
      }
    }

    return {
      activeKeyVersion,
      batchSize,
      maxBatches,
      rotated: totalRotated,
      failed: totalFailed,
      skipped: totalSkipped,
    };
  },
});
