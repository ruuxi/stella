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

export type SpritesExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

const cloudDeviceValidator = v.object({
  _id: v.id("cloud_devices"),
  _creationTime: v.number(),
  ownerId: v.string(),
  provider: v.string(),
  spriteName: v.string(),
  status: v.string(),
  lastActiveAt: v.number(),
  setupComplete: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const enable247ResultValidator = v.union(
  v.object({
    status: v.literal("already_enabled"),
    spriteName: v.string(),
  }),
  v.object({
    status: v.literal("provisioning"),
    spriteName: v.string(),
  }),
);

const disable247ResultValidator = v.union(
  v.object({ status: v.literal("not_enabled") }),
  v.object({ status: v.literal("disabled") }),
);

type Enable247Result =
  | { status: "already_enabled"; spriteName: string }
  | { status: "provisioning"; spriteName: string };

type Disable247Result = { status: "not_enabled" } | { status: "disabled" };

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toString = (value: unknown): string => (typeof value === "string" ? value : "");

const parseExecObject = (value: unknown): SpritesExecResult | null => {
  const record = asRecord(value);
  if (!record) return null;

  const directExitCode =
    toNumber(record.exit_code) ??
    toNumber(record.exitCode) ??
    toNumber(record.code);
  if (directExitCode !== null) {
    return {
      stdout: toString(record.stdout),
      stderr: toString(record.stderr),
      exit_code: directExitCode,
    };
  }

  const nested = asRecord(record.data);
  if (!nested) return null;

  const nestedExitCode =
    toNumber(nested.exit_code) ??
    toNumber(nested.exitCode) ??
    toNumber(nested.code);
  if (nestedExitCode !== null) {
    return {
      stdout: toString(nested.stdout),
      stderr: toString(nested.stderr),
      exit_code: nestedExitCode,
    };
  }

  return null;
};

const parseExecNdjson = (raw: string): SpritesExecResult | null => {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const exec = parseExecObject(parsed);
    if (exec) {
      exitCode = exec.exit_code;
      if (exec.stdout) stdout += exec.stdout;
      if (exec.stderr) stderr += exec.stderr;
      continue;
    }

    const record = asRecord(parsed);
    if (!record) continue;

    if (record.type === "error") {
      const detail = toString(record.error) || toString(record.data) || line;
      throw new Error(`Sprites exec failed: ${detail}`);
    }

    const maybeStdout = toString(record.stdout);
    const maybeStderr = toString(record.stderr);
    if (maybeStdout) stdout += maybeStdout;
    if (maybeStderr) stderr += maybeStderr;
  }

  if (exitCode === null) return null;
  return { stdout, stderr, exit_code: exitCode };
};

const parseExecResponse = (raw: string): SpritesExecResult => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Sprites exec failed: empty response");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const direct = parseExecObject(parsed);
    if (direct) return direct;

    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const entry = parseExecObject(parsed[i]);
        if (entry) return entry;
      }
    }
  } catch {
    // Not plain JSON object/array; try NDJSON.
  }

  const ndjson = parseExecNdjson(raw);
  if (ndjson) return ndjson;

  throw new Error(`Unexpected Sprites exec response: ${trimmed.slice(0, 240)}`);
};

export const spritesApi = async (path: string, method = "GET", body?: unknown) => {
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

/**
 * Like spritesApi but returns raw text. Used for endpoints that return
 * streaming NDJSON (services start/stop, checkpoints create/restore).
 */
export const spritesApiText = async (path: string, method = "GET", body?: unknown) => {
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

  return res.text();
};

export const spritesExec = async (
  spriteName: string,
  command: string,
): Promise<SpritesExecResult> => {
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

  const raw = await res.text();
  return parseExecResponse(raw);
};

export const spritesExecChecked = async (
  spriteName: string,
  command: string,
  context = "Sprites command",
): Promise<SpritesExecResult> => {
  const result = await spritesExec(spriteName, command);
  if (result.exit_code !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const details = stderr || stdout || "(no output)";
    throw new Error(`${context} failed (exit ${result.exit_code}): ${details}`);
  }
  return result;
};

export const assertNdjsonNoError = (raw: string, context: string) => {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type?: string; error?: string; data?: string };
      if (parsed.type === "error") {
        throw new Error(`${context} failed: ${parsed.error ?? parsed.data ?? line}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${context} failed:`)) {
        throw error;
      }
      // Ignore non-JSON lines and continue scanning.
    }
  }
};

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const resolveForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.string(), v.null()),
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
  returns: v.union(cloudDeviceValidator, v.null()),
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
  returns: v.null(),
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
    return null;
  },
});

export const updateStatus = internalMutation({
  args: {
    id: v.id("cloud_devices"),
    status: v.string(),
    setupComplete: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      status: args.status,
      updatedAt: Date.now(),
    };
    if (args.setupComplete !== undefined) {
      patch.setupComplete = args.setupComplete;
    }
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

export const insertCloudDevice = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
  },
  returns: v.id("cloud_devices"),
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
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return null;
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
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      // Install additional tools the base image may not have
      // Sprites already include: Node 22, Python 3.13, Git, sqlite3, ripgrep
      await spritesExecChecked(
        args.spriteName,
        "apt-get update -qq && apt-get install -y -qq jq curl > /dev/null 2>&1",
        "Sprite package install",
      );

      // Install Playwright Chromium for browser automation
      await spritesExecChecked(
        args.spriteName,
        "npx playwright install chromium --with-deps > /dev/null 2>&1",
        "Playwright install",
      );

      // Create a checkpoint after setup for rollback safety
      // Checkpoint creation returns streaming NDJSON, use text variant
      const checkpointResponse = await spritesApiText(`/sprites/${args.spriteName}/checkpoint`, "POST", {
        comment: "initial-setup",
      });
      assertNdjsonNoError(checkpointResponse, "Sprite checkpoint create");

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
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public Queries (for frontend)
// ---------------------------------------------------------------------------

export const getActive = query({
  args: {},
  returns: v.union(cloudDeviceValidator, v.null()),
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
  returns: enable247ResultValidator,
  handler: async (ctx): Promise<Enable247Result> => {
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
  returns: disable247ResultValidator,
  handler: async (ctx): Promise<Disable247Result> => {
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
