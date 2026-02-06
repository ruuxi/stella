import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./auth";

// ---------------------------------------------------------------------------
// Sprites REST API Helpers
// ---------------------------------------------------------------------------

const SPRITES_API_BASE = "https://api.sprites.dev/v1";

const spritesApi = async (path: string, method = "GET", body?: unknown) => {
  const token = process.env.SPRITES_TOKEN;
  if (!token) throw new Error("Missing SPRITES_TOKEN environment variable");

  const res = await fetch(`${SPRITES_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sprites API ${method} ${path}: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
};

export const spritesExec = async (
  spriteName: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exit_code: number }> => {
  const token = process.env.SPRITES_TOKEN;
  if (!token) throw new Error("Missing SPRITES_TOKEN environment variable");

  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-c");
  params.append("cmd", command);

  const res = await fetch(
    `${SPRITES_API_BASE}/sprites/${spriteName}/exec?${params}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sprites exec failed (${res.status}): ${text}`);
  }

  return res.json();
};

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const resolveForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("cloud_devices")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .first();

    if (!record || record.status === "error") return null;
    return record.spriteName;
  },
});

export const getForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cloud_devices")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const touchActivity = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("cloud_devices")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .first();

    if (record) {
      await ctx.db.patch(record._id, {
        lastActiveAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  },
});

export const updateStatus = internalMutation({
  args: {
    id: v.id("cloud_devices"),
    status: v.string(),
    setupComplete: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      status: args.status,
      updatedAt: Date.now(),
    };
    if (args.setupComplete !== undefined) {
      patch.setupComplete = args.setupComplete;
    }
    await ctx.db.patch(args.id, patch);
  },
});

export const insertCloudDevice = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("cloud_devices", {
      ownerId: args.ownerId,
      provider: args.provider,
      spriteName: args.spriteName,
      status: args.status,
      lastActiveAt: now,
      setupComplete: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const deleteCloudDevice = internalMutation({
  args: { id: v.id("cloud_devices") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// ---------------------------------------------------------------------------
// Internal Actions (setup)
// ---------------------------------------------------------------------------

export const setupSprite = internalAction({
  args: {
    deviceId: v.id("cloud_devices"),
    spriteName: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Install additional tools the base image may not have
      // Sprites already include: Node 22, Python 3.13, Git, sqlite3, ripgrep
      await spritesExec(args.spriteName, "apt-get update -qq && apt-get install -y -qq jq > /dev/null 2>&1");

      // Install Playwright Chromium for browser automation
      await spritesExec(
        args.spriteName,
        "npx playwright install chromium --with-deps > /dev/null 2>&1",
      );

      // Create a checkpoint after setup for rollback safety
      await spritesApi(`/sprites/${args.spriteName}/checkpoints`, "POST", {
        comment: "initial-setup",
      });

      await ctx.runMutation(internal.cloud_devices.updateStatus, {
        id: args.deviceId,
        status: "running",
        setupComplete: true,
      });
    } catch (error) {
      console.error("[cloud_devices] Setup failed:", error);
      await ctx.runMutation(internal.cloud_devices.updateStatus, {
        id: args.deviceId,
        status: "error",
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Public Queries (for frontend)
// ---------------------------------------------------------------------------

export const getActive = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const ownerId = identity.subject;

    return await ctx.db
      .query("cloud_devices")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Public Actions (for frontend)
// ---------------------------------------------------------------------------

export const enable247 = action({
  args: {},
  handler: async (ctx): Promise<{ status: string; spriteName: string }> => {
    const ownerId = await requireUserId(ctx);

    // Check if already enabled
    const existing = await ctx.runQuery(internal.cloud_devices.getForOwner, { ownerId });
    if (existing) {
      return { status: "already_enabled", spriteName: existing.spriteName };
    }

    // Generate a unique sprite name
    const suffix = ownerId.slice(-8);
    const rand = Math.random().toString(36).slice(2, 6);
    const spriteName = `stella-${suffix}-${rand}`;

    // Create the sprite
    await spritesApi("/sprites", "POST", { name: spriteName });

    // Insert the record
    const deviceId = await ctx.runMutation(internal.cloud_devices.insertCloudDevice, {
      ownerId,
      provider: "sprites",
      spriteName,
      status: "provisioning",
    });

    // Schedule setup (installs tools, creates checkpoint)
    await ctx.scheduler.runAfter(0, internal.cloud_devices.setupSprite, {
      deviceId,
      spriteName,
    });

    return { status: "provisioning", spriteName };
  },
});

export const disable247 = action({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    const record = await ctx.runQuery(internal.cloud_devices.getForOwner, { ownerId });
    if (!record) {
      return { status: "not_enabled" };
    }

    // Destroy the sprite (irreversible — all data lost)
    try {
      await spritesApi(`/sprites/${record.spriteName}`, "DELETE");
    } catch (error) {
      // If already deleted or 404, continue with cleanup
      console.error("[cloud_devices] Sprite deletion error (continuing):", error);
    }

    // Delete the record
    await ctx.runMutation(internal.cloud_devices.deleteCloudDevice, {
      id: record._id,
    });

    return { status: "disabled" };
  },
});
