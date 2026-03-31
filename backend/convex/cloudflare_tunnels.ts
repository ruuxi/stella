import { v, ConvexError } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

const CF_TUNNEL_DOMAIN = "stellatunnel.com";

const requireCfAccountId = (): string => {
  const id = process.env.CF_ACCOUNT_ID?.trim();
  if (!id) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "CF_ACCOUNT_ID is not configured.",
    });
  }
  return id;
};

const requireCfZoneId = (): string => {
  const id = process.env.CF_ZONE_ID?.trim();
  if (!id) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "CF_ZONE_ID is not configured.",
    });
  }
  return id;
};

const tunnelNameForDevice = (ownerId: string, deviceId: string) => {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  const safeDev = deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  const base = `t-${safeOwner}-${safeDev || "dev"}`;
  return base.slice(0, 63);
};

/** Tunnel rows may omit `deviceId` until a desktop claims the row (older one-row-per-owner data). */
const tunnelRowMissingDeviceId = (row: { deviceId?: string }) =>
  row.deviceId === undefined || row.deviceId === "";

export const getTunnelForOwnerDevice = internalQuery({
  args: { ownerId: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const specific = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (specific) {
      return specific;
    }
    // One tunnel per owner with no deviceId yet; first desktop to request a token claims it.
    const forOwner = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    return (
      forOwner.find((r) => tunnelRowMissingDeviceId(r)) ?? null
    );
  },
});

export const attachDeviceIdToTunnel = internalMutation({
  args: {
    tunnelDocumentId: v.id("cloudflare_tunnels"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tunnelDocumentId);
    if (!row) {
      return;
    }
    if (!tunnelRowMissingDeviceId(row)) {
      return;
    }
    await ctx.db.patch(args.tunnelDocumentId, {
      deviceId: args.deviceId,
      updatedAt: Date.now(),
    });
  },
});

export const upsertTunnel = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    tunnelId: v.string(),
    tunnelName: v.string(),
    tunnelToken: v.string(),
    hostname: v.string(),
    dnsRecordId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tunnelId: args.tunnelId,
        tunnelName: args.tunnelName,
        tunnelToken: args.tunnelToken,
        hostname: args.hostname,
        dnsRecordId: args.dnsRecordId,
        updatedAt: args.updatedAt,
      });
      return;
    }

    await ctx.db.insert("cloudflare_tunnels", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      tunnelId: args.tunnelId,
      tunnelName: args.tunnelName,
      tunnelToken: args.tunnelToken,
      hostname: args.hostname,
      dnsRecordId: args.dnsRecordId,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const getOrProvisionTunnel = internalAction({
  args: { ownerId: v.string(), deviceId: v.string() },
  handler: async (ctx, args): Promise<{ tunnelToken: string; hostname: string }> => {
    const existing = await ctx.runQuery(
      internal.cloudflare_tunnels.getTunnelForOwnerDevice,
      { ownerId: args.ownerId, deviceId: args.deviceId },
    );
    if (existing) {
      if (tunnelRowMissingDeviceId(existing)) {
        await ctx.runMutation(internal.cloudflare_tunnels.attachDeviceIdToTunnel, {
          tunnelDocumentId: existing._id,
          deviceId: args.deviceId,
        });
      }
      return { tunnelToken: existing.tunnelToken, hostname: existing.hostname };
    }

    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken) {
      throw new ConvexError({
        code: "SERVICE_UNAVAILABLE",
        message: "Missing CLOUDFLARE_API_TOKEN",
      });
    }

    const cfAccountId = requireCfAccountId();
    const cfZoneId = requireCfZoneId();

    const tunnelName = tunnelNameForDevice(args.ownerId, args.deviceId);
    const tunnelSecret = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );

    const createTunnelRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/cfd_tunnel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: tunnelName, tunnel_secret: tunnelSecret }),
      },
    );
    const createTunnelBody = (await createTunnelRes.json()) as {
      success: boolean;
      result?: { id: string; token: string };
      errors?: { message: string }[];
    };
    if (!createTunnelBody.success || !createTunnelBody.result) {
      const msg =
        createTunnelBody.errors?.[0]?.message ?? "Failed to create tunnel";
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: msg,
      });
    }

    const tunnelId = createTunnelBody.result.id;
    const tunnelToken = createTunnelBody.result.token;
    const hostname = `${tunnelName}.${CF_TUNNEL_DOMAIN}`;

    const createDnsRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "CNAME",
          name: tunnelName,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
        }),
      },
    );
    const createDnsBody = (await createDnsRes.json()) as {
      success: boolean;
      result?: { id: string };
      errors?: { message: string }[];
    };
    if (!createDnsBody.success || !createDnsBody.result) {
      const msg =
        createDnsBody.errors?.[0]?.message ?? "Failed to create DNS record";
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: msg,
      });
    }

    const dnsRecordId = createDnsBody.result.id;
    const now = Date.now();

    await ctx.runMutation(internal.cloudflare_tunnels.upsertTunnel, {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      tunnelId,
      tunnelName,
      tunnelToken,
      hostname,
      dnsRecordId,
      createdAt: now,
      updatedAt: now,
    });

    return { tunnelToken, hostname };
  },
});
