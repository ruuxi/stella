import { defineTable } from "convex/server";
import { v } from "convex/values";

export const devicesSchema = {
  devices: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    devicePublicKey: v.optional(v.string()),
    lastSignedAtMs: v.optional(v.number()),
    online: v.boolean(),
    platform: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_deviceId", ["deviceId"])
    .index("by_online_and_lastSignedAtMs", ["online", "lastSignedAtMs"]),
    
  anon_device_usage: defineTable({
    deviceId: v.string(),
    requestCount: v.number(),
    firstRequestAt: v.number(),
    lastRequestAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"]),
};
