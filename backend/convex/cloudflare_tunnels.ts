import { v, ConvexError } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

const CF_ACCOUNT_ID = "f34b91c9c7dc22f0aef0ba855a9f026f";
const CF_ZONE_ID = "a7665eb56e4ec7be06f675b2c13077d4";
const CF_TUNNEL_DOMAIN = "stellatunnel.com";

const tunnelNameForDevice = (ownerId: string, deviceId: string) => {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  const safeDev = deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  const base = `t-${safeOwner}-${safeDev || "dev"}`;
  return base.slice(0, 63);
};

export const getTunnelForOwnerDevice = internalQuery({
  args: { ownerId: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
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
      return { tunnelToken: existing.tunnelToken, hostname: existing.hostname };
    }

    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken) {
      throw new ConvexError("Missing CLOUDFLARE_API_TOKEN");
    }

    const tunnelName = tunnelNameForDevice(args.ownerId, args.deviceId);
    const tunnelSecret = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );

    const createTunnelRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel`,
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
      throw new ConvexError(msg);
    }

    const tunnelId = createTunnelBody.result.id;
    const tunnelToken = createTunnelBody.result.token;
    const hostname = `${tunnelName}.${CF_TUNNEL_DOMAIN}`;

    const createDnsRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
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
      throw new ConvexError(msg);
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
