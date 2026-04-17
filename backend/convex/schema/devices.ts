import { defineTable } from "convex/server";
import { v } from "convex/values";

export const devicesSchema = {
  // Stable per-device profile data. High-churn presence fields live in
  // `device_presence` so that frequent heartbeat writes do not contend with
  // reads of identity/profile data.
  devices: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    deviceName: v.optional(v.string()),
    devicePublicKey: v.optional(v.string()),
    platform: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"]),

  // High-churn presence/heartbeat state for devices. One row per (ownerId,
  // deviceId), upserted on every heartbeat. Kept separate from `devices` to
  // avoid rewriting the stable profile row on each heartbeat tick.
  device_presence: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    lastHeartbeatAt: v.optional(v.number()),
    lastSignedAtMs: v.optional(v.number()),
    online: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_online_and_lastSignedAtMs", ["online", "lastSignedAtMs"]),

  anon_device_usage: defineTable({
    deviceId: v.string(),
    requestCount: v.number(),
    firstRequestAt: v.number(),
    lastRequestAt: v.number(),
  }).index("by_deviceId", ["deviceId"]),

  mobile_bridge_registrations: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    baseUrls: v.array(v.string()),
    updatedAt: v.number(),
    platform: v.optional(v.string()),
  })
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  paired_mobile_devices: defineTable({
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    pairSecretHash: v.string(),
    displayName: v.optional(v.string()),
    platform: v.optional(v.string()),
    approvedAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_desktopDeviceId", ["ownerId", "desktopDeviceId"])
    .index("by_ownerId_and_mobileDeviceId", ["ownerId", "mobileDeviceId"])
    .index("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", [
      "ownerId",
      "desktopDeviceId",
      "mobileDeviceId",
    ]),

  mobile_pairing_sessions: defineTable({
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    pairingCode: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_pairingCode", ["pairingCode"])
    .index("by_ownerId_and_desktopDeviceId", ["ownerId", "desktopDeviceId"]),

  mobile_connect_intents: defineTable({
    ownerId: v.string(),
    desktopDeviceId: v.string(),
    mobileDeviceId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_desktopDeviceId_and_expiresAt", [
      "ownerId",
      "desktopDeviceId",
      "expiresAt",
    ])
    .index("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", [
      "ownerId",
      "desktopDeviceId",
      "mobileDeviceId",
    ]),

  cloudflare_tunnels: defineTable({
    ownerId: v.string(),
    /** Desktop machine id (matches `devices.deviceId` / mobile bridge device). Omitted until claimed for older one-row-per-owner tunnel records. */
    deviceId: v.optional(v.string()),
    tunnelId: v.string(),
    tunnelName: v.string(),
    tunnelToken: v.string(),
    hostname: v.string(),
    dnsRecordId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_deviceId", ["ownerId", "deviceId"]),
};
