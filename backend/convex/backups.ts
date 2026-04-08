import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret, encryptSecret } from "./data/secrets_crypto";
import { r2 } from "./r2_files";
import { requireBoundedString } from "./shared_validators";

const BACKUP_KEY_BYTES = 32;
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_HOSTNAME_LENGTH = 200;
const MAX_SNAPSHOT_ID_LENGTH = 200;
const MAX_OBJECT_BATCH_SIZE = 10_000;
const MAX_LIST_LIMIT = 100;
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 60 * 60;

const sha256HexPattern = /^[a-f0-9]{64}$/;

const uploadObjectValidator = v.object({
  objectId: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const uploadedObjectValidator = v.object({
  objectId: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
  r2Key: v.string(),
});

const manifestPayloadValidator = v.object({
  r2Key: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const backupSummaryValidator = v.object({
  snapshotId: v.string(),
  snapshotHash: v.string(),
  sourceDeviceId: v.string(),
  sourceHostname: v.optional(v.string()),
  createdAt: v.number(),
  entryCount: v.number(),
  objectCount: v.number(),
  isLatest: v.boolean(),
});

const manifestDownloadPlanValidator = v.object({
  snapshot: backupSummaryValidator,
  keyBase64Url: v.string(),
  manifest: v.object({
    downloadUrl: v.string(),
    r2Key: v.string(),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    algorithm: v.string(),
    ivBase64Url: v.string(),
    authTagBase64Url: v.string(),
  }),
});

const objectDownloadValidator = v.object({
  objectId: v.string(),
  downloadUrl: v.string(),
  r2Key: v.string(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  algorithm: v.string(),
  ivBase64Url: v.string(),
  authTagBase64Url: v.string(),
});

const keyEscrowStatusValidator = v.union(
  v.null(),
  v.object({
    keyBase64Url: v.string(),
    keyFingerprint: v.string(),
    updatedAt: v.number(),
  }),
);

const keyEnsureResultValidator = v.object({
  status: v.union(
    v.literal("created"),
    v.literal("matched"),
    v.literal("mismatch"),
  ),
  keyFingerprint: v.string(),
  updatedAt: v.number(),
  remoteKeyBase64Url: v.optional(v.string()),
});

const prepareUploadResultValidator = v.object({
  existingObjectIds: v.array(v.string()),
  missingObjects: v.array(
    v.object({
      objectId: v.string(),
      r2Key: v.string(),
      uploadUrl: v.string(),
    }),
  ),
  manifest: v.object({
    r2Key: v.string(),
    uploadUrl: v.string(),
  }),
});

const finalizeUploadResultValidator = v.object({
  snapshotId: v.string(),
  isLatest: v.boolean(),
});

const trimRequired = (
  value: string,
  fieldName: string,
  maxLength: number,
): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} is required.`,
    });
  }
  requireBoundedString(trimmed, fieldName, maxLength);
  return trimmed;
};

const requireSha256Hex = (value: string, fieldName: string): string => {
  const normalized = trimRequired(value, fieldName, 64).toLowerCase();
  if (!sha256HexPattern.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a 64-character sha256 hex string.`,
    });
  }
  return normalized;
};

const requireKeyBase64Url = (value: string): string => {
  const trimmed = trimRequired(value, "keyBase64Url", 256);
  const decoded = Buffer.from(trimmed, "base64url");
  if (decoded.byteLength !== BACKUP_KEY_BYTES) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Backup key must be 32 bytes.",
    });
  }
  return trimmed;
};

const sanitizeLimit = (value: number | undefined) => {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `limit must be between 1 and ${MAX_LIST_LIMIT}.`,
    });
  }
  return value;
};

const requireBatchSize = (size: number, fieldName: string) => {
  if (size > MAX_OBJECT_BATCH_SIZE) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} exceeds the maximum batch size of ${MAX_OBJECT_BATCH_SIZE}.`,
    });
  }
};

const encodeKeyPart = (value: string) => encodeURIComponent(value);

const getObjectR2Key = (ownerId: string, objectId: string) =>
  `backups/${encodeKeyPart(ownerId)}/objects/${objectId}.bin`;

const getManifestR2Key = (ownerId: string, snapshotId: string) =>
  `backups/${encodeKeyPart(ownerId)}/manifests/${encodeKeyPart(snapshotId)}.bin`;

const toBackupSummary = (record: {
  snapshotId: string;
  snapshotHash: string;
  sourceDeviceId: string;
  sourceHostname?: string;
  createdAt: number;
  entryCount: number;
  objectCount: number;
  isLatest: boolean;
}) => ({
  snapshotId: record.snapshotId,
  snapshotHash: record.snapshotHash,
  sourceDeviceId: record.sourceDeviceId,
  sourceHostname: record.sourceHostname,
  createdAt: record.createdAt,
  entryCount: record.entryCount,
  objectCount: record.objectCount,
  isLatest: record.isLatest,
});

const requireRegisteredDevice = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deviceId: string,
) => {
  const normalizedDeviceId = trimRequired(
    deviceId,
    "deviceId",
    MAX_DEVICE_ID_LENGTH,
  );
  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", normalizedDeviceId),
    )
    .unique();
  if (!device) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "This device is not registered for the signed-in account.",
    });
  }
  return normalizedDeviceId;
};

const getKeyEscrowRecord = async (ctx: QueryCtx | MutationCtx, ownerId: string) => {
  return await ctx.db
    .query("backup_key_escrows")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
};

const getManifestRecord = async (ctx: QueryCtx | MutationCtx, ownerId: string, snapshotId: string) =>
  await ctx.db
    .query("backup_manifests")
    .withIndex("by_ownerId_and_snapshotId", (q) =>
      q.eq("ownerId", ownerId).eq("snapshotId", snapshotId),
    )
    .unique();

const getObjectRecord = async (ctx: QueryCtx | MutationCtx, ownerId: string, objectId: string) =>
  await ctx.db
    .query("backup_objects")
    .withIndex("by_ownerId_and_objectId", (q) =>
      q.eq("ownerId", ownerId).eq("objectId", objectId),
    )
    .unique();

export const assertDeviceOwnedInternal = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.object({
    deviceId: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const deviceId = await requireRegisteredDevice(ctx, ownerId, args.deviceId);
    return { deviceId };
  },
});

type KeyEscrowStatus = {
  keyBase64Url: string;
  keyFingerprint: string;
  updatedAt: number;
} | null;

export const getKeyEscrowStatusInternal = internalAction({
  args: {
    ownerId: v.string(),
  },
  returns: keyEscrowStatusValidator,
  handler: async (ctx, args): Promise<KeyEscrowStatus> => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const row: { encryptedKey: string; keyFingerprint: string; updatedAt: number } | null =
      await ctx.runQuery(internal.backups.getKeyEscrowRowInternal, {
        ownerId,
      });
    if (!row) {
      return null;
    }
    return {
      keyBase64Url: await decryptSecret(row.encryptedKey),
      keyFingerprint: row.keyFingerprint,
      updatedAt: row.updatedAt,
    };
  },
});

export const getKeyEscrowRowInternal = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      encryptedKey: v.string(),
      keyFingerprint: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const row = await getKeyEscrowRecord(ctx, ownerId);
    if (!row) {
      return null;
    }
    return {
      encryptedKey: row.encryptedKey,
      keyFingerprint: row.keyFingerprint,
      updatedAt: row.updatedAt,
    };
  },
});

export const ensureKeyEscrowInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    keyBase64Url: v.string(),
    keyFingerprint: v.string(),
  },
  returns: keyEnsureResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const sourceDeviceId = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.sourceDeviceId,
    );
    const keyBase64Url = requireKeyBase64Url(args.keyBase64Url);
    const keyFingerprint = requireSha256Hex(
      args.keyFingerprint,
      "keyFingerprint",
    );
    const now = Date.now();
    const existing = await getKeyEscrowRecord(ctx, ownerId);
    if (!existing) {
      const encryptedPayload = await encryptSecret(keyBase64Url);
      await ctx.db.insert("backup_key_escrows", {
        ownerId,
        encryptedKey: JSON.stringify(encryptedPayload),
        keyFingerprint,
        keyVersion: encryptedPayload.keyVersion,
        sourceDeviceId,
        createdAt: now,
        updatedAt: now,
      });
      return {
        status: "created" as const,
        keyFingerprint,
        updatedAt: now,
      };
    }

    if (existing.keyFingerprint === keyFingerprint) {
      return {
        status: "matched" as const,
        keyFingerprint,
        updatedAt: existing.updatedAt,
      };
    }

    return {
      status: "mismatch" as const,
      keyFingerprint: existing.keyFingerprint,
      updatedAt: existing.updatedAt,
      remoteKeyBase64Url: await decryptSecret(existing.encryptedKey),
    };
  },
});

export const prepareUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    snapshotId: v.string(),
    snapshotHash: v.string(),
    createdAt: v.number(),
    objects: v.array(uploadObjectValidator),
  },
  returns: prepareUploadResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const sourceDeviceId = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.sourceDeviceId,
    );
    const snapshotId = trimRequired(
      args.snapshotId,
      "snapshotId",
      MAX_SNAPSHOT_ID_LENGTH,
    );
    requireSha256Hex(args.snapshotHash, "snapshotHash");
    requireBatchSize(args.objects.length, "objects");

    const existingObjectIds: string[] = [];
    const missingObjects: Array<{
      objectId: string;
      r2Key: string;
      uploadUrl: string;
    }> = [];

    for (const object of args.objects) {
      const objectId = requireSha256Hex(object.objectId, "objectId");
      requireSha256Hex(object.plaintextSha256, "plaintextSha256");
      trimRequired(object.algorithm, "algorithm", 50);
      trimRequired(object.ivBase64Url, "ivBase64Url", 128);
      trimRequired(object.authTagBase64Url, "authTagBase64Url", 128);
      if (!Number.isFinite(object.plaintextSize) || object.plaintextSize < 0) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "plaintextSize must be a non-negative number.",
        });
      }
      const existing = await getObjectRecord(ctx, ownerId, objectId);
      if (existing) {
        existingObjectIds.push(objectId);
        continue;
      }
      const r2Key = getObjectR2Key(ownerId, objectId);
      const upload = await r2.generateUploadUrl(r2Key);
      missingObjects.push({
        objectId,
        r2Key,
        uploadUrl: upload.url,
      });
    }

    const manifestR2Key = getManifestR2Key(ownerId, snapshotId);
    const manifestUpload = await r2.generateUploadUrl(manifestR2Key);
    void sourceDeviceId;
    void args.createdAt;

    return {
      existingObjectIds,
      missingObjects,
      manifest: {
        r2Key: manifestR2Key,
        uploadUrl: manifestUpload.url,
      },
    };
  },
});

export const finalizeUploadInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.string(),
    snapshotId: v.string(),
    snapshotHash: v.string(),
    createdAt: v.number(),
    sourceHostname: v.optional(v.string()),
    version: v.number(),
    entryCount: v.number(),
    objectCount: v.number(),
    markLatest: v.optional(v.boolean()),
    manifest: manifestPayloadValidator,
    uploadedObjects: v.array(uploadedObjectValidator),
  },
  returns: finalizeUploadResultValidator,
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const sourceDeviceId = await requireRegisteredDevice(
      ctx,
      ownerId,
      args.sourceDeviceId,
    );
    const snapshotId = trimRequired(
      args.snapshotId,
      "snapshotId",
      MAX_SNAPSHOT_ID_LENGTH,
    );
    const snapshotHash = requireSha256Hex(args.snapshotHash, "snapshotHash");
    const sourceHostname = args.sourceHostname
      ? trimRequired(args.sourceHostname, "sourceHostname", MAX_HOSTNAME_LENGTH)
      : undefined;
    if (!Number.isFinite(args.createdAt) || args.createdAt <= 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "createdAt must be a positive timestamp.",
      });
    }
    if (!Number.isInteger(args.entryCount) || args.entryCount < 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "entryCount must be a non-negative integer.",
      });
    }
    if (!Number.isInteger(args.objectCount) || args.objectCount < 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "objectCount must be a non-negative integer.",
      });
    }
    requireBatchSize(args.uploadedObjects.length, "uploadedObjects");
    const now = Date.now();

    requireSha256Hex(args.manifest.plaintextSha256, "manifest.plaintextSha256");
    trimRequired(args.manifest.r2Key, "manifest.r2Key", 1000);
    trimRequired(args.manifest.algorithm, "manifest.algorithm", 50);
    trimRequired(args.manifest.ivBase64Url, "manifest.ivBase64Url", 128);
    trimRequired(
      args.manifest.authTagBase64Url,
      "manifest.authTagBase64Url",
      128,
    );
    if (
      !Number.isFinite(args.manifest.plaintextSize)
      || args.manifest.plaintextSize < 0
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "manifest.plaintextSize must be a non-negative number.",
      });
    }

    for (const object of args.uploadedObjects) {
      const objectId = requireSha256Hex(object.objectId, "objectId");
      const plaintextSha256 = requireSha256Hex(
        object.plaintextSha256,
        "plaintextSha256",
      );
      trimRequired(object.r2Key, "r2Key", 1000);
      trimRequired(object.algorithm, "algorithm", 50);
      trimRequired(object.ivBase64Url, "ivBase64Url", 128);
      trimRequired(object.authTagBase64Url, "authTagBase64Url", 128);
      if (!Number.isFinite(object.plaintextSize) || object.plaintextSize < 0) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "plaintextSize must be a non-negative number.",
        });
      }
      const existing = await getObjectRecord(ctx, ownerId, objectId);
      if (existing) {
        if (
          existing.plaintextSha256 !== plaintextSha256
          || existing.ivBase64Url !== object.ivBase64Url
          || existing.authTagBase64Url !== object.authTagBase64Url
          || existing.r2Key !== object.r2Key
        ) {
          throw new ConvexError({
            code: "CONFLICT",
            message: `Remote backup object ${objectId} already exists with different metadata.`,
          });
        }
        continue;
      }
      await ctx.db.insert("backup_objects", {
        ownerId,
        objectId,
        r2Key: object.r2Key,
        algorithm: object.algorithm,
        plaintextSha256,
        plaintextSize: object.plaintextSize,
        ivBase64Url: object.ivBase64Url,
        authTagBase64Url: object.authTagBase64Url,
        sourceDeviceId,
        createdAt: now,
      });
    }

    const shouldMarkLatest = args.markLatest ?? true;
    if (shouldMarkLatest) {
      const currentLatest = await ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_isLatest", (q) =>
          q.eq("ownerId", ownerId).eq("isLatest", true),
        )
        .collect();
      await Promise.all(
        currentLatest.map(async (row) => {
          if (row.snapshotId !== snapshotId) {
            await ctx.db.patch(row._id, {
              isLatest: false,
              updatedAt: now,
            });
          }
        }),
      );
    }

    const existingManifest = await getManifestRecord(ctx, ownerId, snapshotId);
    if (existingManifest) {
      await ctx.db.patch(existingManifest._id, {
        snapshotHash,
        sourceDeviceId,
        sourceHostname,
        manifestR2Key: args.manifest.r2Key,
        manifestAlgorithm: args.manifest.algorithm,
        manifestPlaintextSha256: args.manifest.plaintextSha256,
        manifestPlaintextSize: args.manifest.plaintextSize,
        manifestIvBase64Url: args.manifest.ivBase64Url,
        manifestAuthTagBase64Url: args.manifest.authTagBase64Url,
        entryCount: args.entryCount,
        objectCount: args.objectCount,
        isLatest: shouldMarkLatest,
        version: args.version,
        createdAt: args.createdAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("backup_manifests", {
        ownerId,
        snapshotId,
        snapshotHash,
        sourceDeviceId,
        sourceHostname,
        manifestR2Key: args.manifest.r2Key,
        manifestAlgorithm: args.manifest.algorithm,
        manifestPlaintextSha256: args.manifest.plaintextSha256,
        manifestPlaintextSize: args.manifest.plaintextSize,
        manifestIvBase64Url: args.manifest.ivBase64Url,
        manifestAuthTagBase64Url: args.manifest.authTagBase64Url,
        entryCount: args.entryCount,
        objectCount: args.objectCount,
        isLatest: shouldMarkLatest,
        version: args.version,
        createdAt: args.createdAt,
        updatedAt: now,
      });
    }

    return {
      snapshotId,
      isLatest: shouldMarkLatest,
    };
  },
});

export const listBackupsForOwnerInternal = internalQuery({
  args: {
    ownerId: v.string(),
    sourceDeviceId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(backupSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const limit = sanitizeLimit(args.limit);
    const sourceDeviceId = args.sourceDeviceId?.trim();
    const rows = sourceDeviceId
      ? await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_sourceDeviceId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId).eq("sourceDeviceId", sourceDeviceId),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
          .order("desc")
          .take(limit);
    return rows.map(toBackupSummary);
  },
});

export const getManifestRecordInternal = internalQuery({
  args: {
    ownerId: v.string(),
    snapshotId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      snapshotId: v.string(),
      snapshotHash: v.string(),
      sourceDeviceId: v.string(),
      sourceHostname: v.optional(v.string()),
      createdAt: v.number(),
      entryCount: v.number(),
      objectCount: v.number(),
      isLatest: v.boolean(),
      manifestR2Key: v.string(),
      manifestAlgorithm: v.string(),
      manifestPlaintextSha256: v.string(),
      manifestPlaintextSize: v.number(),
      manifestIvBase64Url: v.string(),
      manifestAuthTagBase64Url: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    const snapshotId = trimRequired(
      args.snapshotId,
      "snapshotId",
      MAX_SNAPSHOT_ID_LENGTH,
    );
    const row = await getManifestRecord(ctx, ownerId, snapshotId);
    if (!row) {
      return null;
    }
    return {
      snapshotId: row.snapshotId,
      snapshotHash: row.snapshotHash,
      sourceDeviceId: row.sourceDeviceId,
      sourceHostname: row.sourceHostname,
      createdAt: row.createdAt,
      entryCount: row.entryCount,
      objectCount: row.objectCount,
      isLatest: row.isLatest,
      manifestR2Key: row.manifestR2Key,
      manifestAlgorithm: row.manifestAlgorithm,
      manifestPlaintextSha256: row.manifestPlaintextSha256,
      manifestPlaintextSize: row.manifestPlaintextSize,
      manifestIvBase64Url: row.manifestIvBase64Url,
      manifestAuthTagBase64Url: row.manifestAuthTagBase64Url,
    };
  },
});

type ManifestRecordResult = {
  snapshotId: string;
  snapshotHash: string;
  sourceDeviceId: string;
  sourceHostname?: string;
  createdAt: number;
  entryCount: number;
  objectCount: number;
  isLatest: boolean;
  manifestR2Key: string;
  manifestAlgorithm: string;
  manifestPlaintextSha256: string;
  manifestPlaintextSize: number;
  manifestIvBase64Url: string;
  manifestAuthTagBase64Url: string;
};

type ObjectRecordResult = {
  objectId: string;
  r2Key: string;
  plaintextSha256: string;
  plaintextSize: number;
  algorithm: string;
  ivBase64Url: string;
  authTagBase64Url: string;
};

type ManifestDownloadPlan = {
  snapshot: ReturnType<typeof toBackupSummary>;
  keyBase64Url: string;
  manifest: {
    downloadUrl: string;
    r2Key: string;
    plaintextSha256: string;
    plaintextSize: number;
    algorithm: string;
    ivBase64Url: string;
    authTagBase64Url: string;
  };
};

export const getManifestDownloadPlanInternal = internalAction({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    snapshotId: v.string(),
  },
  returns: manifestDownloadPlanValidator,
  handler: async (ctx, args): Promise<ManifestDownloadPlan> => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    await ctx.runQuery(internal.backups.assertDeviceOwnedInternal, {
      ownerId,
      deviceId: args.deviceId,
    });
    const manifest: ManifestRecordResult | null = await ctx.runQuery(
      internal.backups.getManifestRecordInternal,
      { ownerId, snapshotId: args.snapshotId },
    );
    if (!manifest) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup manifest not found.",
      });
    }
    const escrowRow: { encryptedKey: string; keyFingerprint: string; updatedAt: number } | null =
      await ctx.runQuery(internal.backups.getKeyEscrowRowInternal, { ownerId });
    const key: KeyEscrowStatus = escrowRow
      ? {
          keyBase64Url: await decryptSecret(escrowRow.encryptedKey),
          keyFingerprint: escrowRow.keyFingerprint,
          updatedAt: escrowRow.updatedAt,
        }
      : null;
    if (!key) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Backup encryption key not found for this account.",
      });
    }
    return {
      snapshot: toBackupSummary(manifest),
      keyBase64Url: key.keyBase64Url,
      manifest: {
        downloadUrl: await r2.getUrl(manifest.manifestR2Key, {
          expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        }),
        r2Key: manifest.manifestR2Key,
        plaintextSha256: manifest.manifestPlaintextSha256,
        plaintextSize: manifest.manifestPlaintextSize,
        algorithm: manifest.manifestAlgorithm,
        ivBase64Url: manifest.manifestIvBase64Url,
        authTagBase64Url: manifest.manifestAuthTagBase64Url,
      },
    };
  },
});

export const getObjectRecordsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    objectIds: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      objectId: v.string(),
      r2Key: v.string(),
      plaintextSha256: v.string(),
      plaintextSize: v.number(),
      algorithm: v.string(),
      ivBase64Url: v.string(),
      authTagBase64Url: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    requireBatchSize(args.objectIds.length, "objectIds");
    const uniqueObjectIds = [...new Set(args.objectIds.map((value) => requireSha256Hex(value, "objectId")))];
    const results = [];
    for (const objectId of uniqueObjectIds) {
      const row = await getObjectRecord(ctx, ownerId, objectId);
      if (!row) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: `Backup object ${objectId} not found.`,
        });
      }
      results.push({
        objectId: row.objectId,
        r2Key: row.r2Key,
        plaintextSha256: row.plaintextSha256,
        plaintextSize: row.plaintextSize,
        algorithm: row.algorithm,
        ivBase64Url: row.ivBase64Url,
        authTagBase64Url: row.authTagBase64Url,
      });
    }
    return results;
  },
});

export const getObjectDownloadPlanInternal = internalAction({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    objectIds: v.array(v.string()),
  },
  returns: v.array(objectDownloadValidator),
  handler: async (ctx, args) => {
    const ownerId = trimRequired(args.ownerId, "ownerId", 300);
    await ctx.runQuery(internal.backups.assertDeviceOwnedInternal, {
      ownerId,
      deviceId: args.deviceId,
    });
    const objects: ObjectRecordResult[] = await ctx.runQuery(
      internal.backups.getObjectRecordsInternal,
      { ownerId, objectIds: args.objectIds },
    );
    return await Promise.all(
      objects.map(async (object: ObjectRecordResult) => ({
        objectId: object.objectId,
        downloadUrl: await r2.getUrl(object.r2Key, {
          expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        }),
        r2Key: object.r2Key,
        plaintextSha256: object.plaintextSha256,
        plaintextSize: object.plaintextSize,
        algorithm: object.algorithm,
        ivBase64Url: object.ivBase64Url,
        authTagBase64Url: object.authTagBase64Url,
      })),
    );
  },
});
