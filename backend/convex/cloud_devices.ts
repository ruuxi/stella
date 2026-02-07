import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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

const runtimeModeValidator = v.union(v.literal("local"), v.literal("cloud_247"));
const runtimeStatusValidator = v.object({
  mode: runtimeModeValidator,
  enabled: v.boolean(),
  cloudDevice: v.union(cloudDeviceValidator, v.null()),
});

const RUNTIME_MODE_KEY = "runtime_mode";
const normalizeRuntimeMode = (value: string | null | undefined): "local" | "cloud_247" =>
  value === "cloud_247" ? "cloud_247" : "local";

type RuntimeStatus = {
  mode: "local" | "cloud_247";
  enabled: boolean;
  cloudDevice: Doc<"cloud_devices"> | null;
};

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

/**
 * Parse the binary multiplexed exec protocol.
 * Format: sequence of (type_byte + payload) chunks:
 *   0x01 … = stdout (until next type byte or end)
 *   0x02 … = stderr
 *   0x03 XX = exit code (single byte)
 */
const parseBinaryExecResponse = (
  buf: ArrayBuffer,
): SpritesExecResult | null => {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return null;

  // Quick check: first byte must be a known type marker
  if (bytes[0] !== 0x01 && bytes[0] !== 0x02 && bytes[0] !== 0x03) return null;

  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  let i = 0;
  while (i < bytes.length) {
    const marker = bytes[i];
    if (marker === 0x03) {
      // Exit code: single byte follows
      exitCode = i + 1 < bytes.length ? bytes[i + 1] : 0;
      i += 2;
    } else if (marker === 0x01 || marker === 0x02) {
      // Collect bytes until next marker or end
      const start = i + 1;
      let end = start;
      while (end < bytes.length && bytes[end] !== 0x01 && bytes[end] !== 0x02 && bytes[end] !== 0x03) {
        end++;
      }
      const chunk = decoder.decode(bytes.slice(start, end));
      if (marker === 0x01) stdout += chunk;
      else stderr += chunk;
      i = end;
    } else {
      // Unknown marker — not binary protocol
      return null;
    }
  }

  if (exitCode === null) return null;
  return { stdout, stderr, exit_code: exitCode };
};

const parseExecResponse = (raw: string, rawBuffer?: ArrayBuffer): SpritesExecResult => {
  // Try binary protocol first if we have the buffer
  if (rawBuffer) {
    const binary = parseBinaryExecResponse(rawBuffer);
    if (binary) return binary;
  }

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

  const rawBuffer = await res.arrayBuffer();
  const raw = new TextDecoder().decode(rawBuffer);
  return parseExecResponse(raw, rawBuffer);
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
    const runtimePreference = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();
    const runtimeMode = normalizeRuntimeMode(runtimePreference?.value ?? null);
    if (runtimeMode !== "cloud_247") {
      return null;
    }

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

export const get247Status = query({
  args: {},
  returns: runtimeStatusValidator,
  handler: async (ctx): Promise<RuntimeStatus> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        mode: "local",
        enabled: false,
        cloudDevice: null,
      };
    }

    const ownerId = identity.subject;
    const runtimePreference = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();
    const mode = normalizeRuntimeMode(runtimePreference?.value ?? null);
    const cloudDevice = await ctx.db
      .query("cloud_devices")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .first();

    return {
      mode,
      enabled: mode === "cloud_247",
      cloudDevice: cloudDevice ?? null,
    };
  },
});

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

const ensure247ForOwner = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<Enable247Result> => {
  const existing = await ctx.runQuery(internal.cloud_devices.getForOwner, { ownerId });
  if (existing) {
    await ctx.runMutation(internal.preferences.setPreferenceForOwner, {
      ownerId,
      key: RUNTIME_MODE_KEY,
      value: "cloud_247",
    });
    return { status: "already_enabled", spriteName: existing.spriteName };
  }

  const suffix = ownerId.slice(-8);
  const rand = Math.random().toString(36).slice(2, 6);
  const spriteName = `stella-${suffix}-${rand}`;

  await spritesApi("/sprites", "POST", { name: spriteName });

  const deviceId = await ctx.runMutation(internal.cloud_devices.insertCloudDevice, {
    ownerId,
    provider: "sprites",
    spriteName,
    status: "provisioning",
  });

  await ctx.scheduler.runAfter(0, internal.cloud_devices.setupSprite, {
    deviceId,
    spriteName,
  });

  await ctx.runMutation(internal.preferences.setPreferenceForOwner, {
    ownerId,
    key: RUNTIME_MODE_KEY,
    value: "cloud_247",
  });

  return { status: "provisioning", spriteName };
};

const disable247ForOwner = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<Disable247Result> => {
  const record = await ctx.runQuery(internal.cloud_devices.getForOwner, { ownerId });
  if (!record) {
    await ctx.runMutation(internal.preferences.setPreferenceForOwner, {
      ownerId,
      key: RUNTIME_MODE_KEY,
      value: "local",
    });
    return { status: "not_enabled" };
  }

  try {
    await spritesApi(`/sprites/${record.spriteName}`, "DELETE");
  } catch (error) {
    console.error("[cloud_devices] Sprite deletion error (continuing):", error);
  }

  await ctx.runMutation(internal.cloud_devices.deleteCloudDevice, {
    id: record._id,
  });

  await ctx.runMutation(internal.preferences.setPreferenceForOwner, {
    ownerId,
    key: RUNTIME_MODE_KEY,
    value: "local",
  });

  return { status: "disabled" };
};

export const set247Enabled = action({
  args: {
    enabled: v.boolean(),
  },
  returns: runtimeStatusValidator,
  handler: async (ctx, args): Promise<RuntimeStatus> => {
    const ownerId = await requireUserId(ctx);

    if (args.enabled) {
      await ensure247ForOwner(ctx, ownerId);
    } else {
      await ctx.runMutation(internal.preferences.setPreferenceForOwner, {
        ownerId,
        key: RUNTIME_MODE_KEY,
        value: "local",
      });
      try {
        await ctx.runAction(api.bridge.stopBridge, { provider: "whatsapp" });
      } catch {
        // Best effort: bridge may already be stopped.
      }
      try {
        await ctx.runAction(api.bridge.stopBridge, { provider: "signal" });
      } catch {
        // Best effort: bridge may already be stopped.
      }
      await disable247ForOwner(ctx, ownerId);
    }

    const cloudDevice = await ctx.runQuery(internal.cloud_devices.getForOwner, { ownerId });
    return {
      mode: args.enabled ? "cloud_247" : "local",
      enabled: args.enabled,
      cloudDevice: cloudDevice ?? null,
    };
  },
});

export const enable247 = action({
  args: {},
  returns: enable247ResultValidator,
  handler: async (ctx): Promise<Enable247Result> => {
    const ownerId = await requireUserId(ctx);
    return await ensure247ForOwner(ctx, ownerId);
  },
});

export const disable247 = action({
  args: {},
  returns: disable247ResultValidator,
  handler: async (ctx): Promise<Disable247Result> => {
    const ownerId = await requireUserId(ctx);
    return await disable247ForOwner(ctx, ownerId);
  },
});
