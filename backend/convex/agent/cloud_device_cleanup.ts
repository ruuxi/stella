import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { getSpritesTokenForOwner, spritesApi } from "./cloud_devices";

const RUNTIME_MODE_KEY = "runtime_mode";
const INACTIVITY_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const DEFAULT_INACTIVE_CLEANUP_LIMIT = 200;

type InactiveCleanupResult = {
  checked: number;
  deletedRecords: number;
  deletedSprites: number;
  failedDeletes: number;
};

const isSpriteNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("sprites api delete /sprites/") && message.includes(": 404");
};

export const cleanupInactive = internalAction({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    deletedRecords: v.number(),
    deletedSprites: v.number(),
    failedDeletes: v.number(),
  }),
  handler: async (ctx, args): Promise<InactiveCleanupResult> => {
    const nowMs = args.nowMs ?? Date.now();
    const cutoffMs = nowMs - INACTIVITY_RETENTION_MS;
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_INACTIVE_CLEANUP_LIMIT, 500));
    const candidates: Doc<"cloud_devices">[] = await ctx.runQuery(
      internal.agent.cloud_devices.listInactiveBefore,
      {
        cutoffMs,
        limit,
      },
    );

    let deletedRecords = 0;
    let deletedSprites = 0;
    let failedDeletes = 0;
    const touchedOwners = new Set<string>();

    for (const candidate of candidates) {
      let canDeleteRecord = true;
      let spritesToken: string;
      try {
        spritesToken = await getSpritesTokenForOwner(ctx, candidate.ownerId);
      } catch (error) {
        canDeleteRecord = false;
        failedDeletes += 1;
        console.error("[cloud_device_cleanup] Missing owner token during sprite deletion:", {
          ownerId: candidate.ownerId,
          spriteName: candidate.spriteName,
          error,
        });
        continue;
      }
      try {
        await spritesApi(spritesToken, `/sprites/${candidate.spriteName}`, "DELETE");
        deletedSprites += 1;
      } catch (error) {
        if (!isSpriteNotFoundError(error)) {
          canDeleteRecord = false;
          failedDeletes += 1;
          console.error("[cloud_device_cleanup] Inactive sprite deletion failed:", {
            ownerId: candidate.ownerId,
            spriteName: candidate.spriteName,
            error,
          });
        }
      }

      if (!canDeleteRecord) {
        continue;
      }

      await ctx.runMutation(internal.agent.cloud_devices.deleteCloudDevice, {
        id: candidate._id,
      });
      deletedRecords += 1;
      touchedOwners.add(candidate.ownerId);
    }

    for (const ownerId of touchedOwners) {
      const remaining = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, { ownerId });
      if (remaining) continue;
      await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
        ownerId,
        key: RUNTIME_MODE_KEY,
        value: "local",
      });
    }

    return {
      checked: candidates.length,
      deletedRecords,
      deletedSprites,
      failedDeletes,
    };
  },
});
