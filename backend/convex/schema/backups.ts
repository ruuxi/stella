import { defineTable } from "convex/server";
import { v } from "convex/values";

export const backupsSchema = {
  backup_key_escrows: defineTable({
    ownerId: v.string(),
    encryptedKey: v.string(),
    keyFingerprint: v.string(),
    keyVersion: v.number(),
    sourceDeviceId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  backup_objects: defineTable({
    ownerId: v.string(),
    objectId: v.string(),
    r2Key: v.string(),
    algorithm: v.string(),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    ivBase64Url: v.string(),
    authTagBase64Url: v.string(),
    sourceDeviceId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_objectId", ["ownerId", "objectId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  backup_manifests: defineTable({
    ownerId: v.string(),
    snapshotId: v.string(),
    snapshotHash: v.string(),
    sourceDeviceId: v.string(),
    sourceHostname: v.optional(v.string()),
    manifestR2Key: v.string(),
    manifestAlgorithm: v.string(),
    manifestPlaintextSha256: v.string(),
    manifestPlaintextSize: v.number(),
    manifestIvBase64Url: v.string(),
    manifestAuthTagBase64Url: v.string(),
    entryCount: v.number(),
    objectCount: v.number(),
    isLatest: v.boolean(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_snapshotId", ["ownerId", "snapshotId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_isLatest", ["ownerId", "isLatest"])
    .index("by_ownerId_and_sourceDeviceId_and_createdAt", [
      "ownerId",
      "sourceDeviceId",
      "createdAt",
    ]),
};
