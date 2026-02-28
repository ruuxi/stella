import { defineTable } from "convex/server";
import { v } from "convex/values";

export const devicesSchema = {
  remote_computers: defineTable({
    ownerId: v.string(),
    railwayServiceId: v.string(),
    domain: v.string(),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_railwayServiceId", ["railwayServiceId"]),

  devices: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    devicePublicKey: v.optional(v.string()),
    lastSignedAtMs: v.optional(v.number()),
    online: v.boolean(),
    platform: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_deviceId", ["deviceId"]),

  cloud_devices: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
    lastActiveAt: v.number(),
    setupComplete: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_lastActiveAt", ["lastActiveAt"])
    .index("by_spriteName", ["spriteName"]),
    
  anon_device_usage: defineTable({
    deviceId: v.string(),
    requestCount: v.number(),
    firstRequestAt: v.number(),
    lastRequestAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"]),
};
