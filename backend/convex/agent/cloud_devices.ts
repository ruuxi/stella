import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { requireUserId } from "../auth";

// ---------------------------------------------------------------------------
// Sprites REST API Helpers
// ---------------------------------------------------------------------------

const SPRITES_API_BASE = "https://api.sprites.dev/v1";
const SPRITES_SECRET_PROVIDER = "sprites_api_token";
const SPRITES_OWNER_TOKEN_MAP_ENV = "SPRITES_TOKENS_JSON";
const SPRITES_MANAGED_SECRET_LABEL = "Managed Sprites API token";

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
const cloudDeviceListValidator = v.array(cloudDeviceValidator);
const ensureSingleRecordResultValidator = v.object({
  cloudDevice: cloudDeviceValidator,
  created: v.boolean(),
});

const RUNTIME_MODE_KEY = "runtime_mode";
const normalizeRuntimeMode = (value: string | null | undefined): "local" | "cloud_247" =>
  value === "cloud_247" ? "cloud_247" : "local";

type RuntimeStatus = {
  mode: "local" | "cloud_247";
  enabled: boolean;
  cloudDevice: Doc<"cloud_devices"> | null;
};

const cloudStatusRank = (status: string): number => {
  switch (status) {
    case "running":
      return 4;
    case "provisioning":
      return 3;
    case "stopped":
      return 2;
    case "error":
      return 0;
    default:
      return 1;
  }
};

const compareCloudDevices = (a: Doc<"cloud_devices">, b: Doc<"cloud_devices">): number => {
  const setupDelta = Number(b.setupComplete) - Number(a.setupComplete);
  if (setupDelta !== 0) return setupDelta;

  const statusDelta = cloudStatusRank(b.status) - cloudStatusRank(a.status);
  if (statusDelta !== 0) return statusDelta;

  const activityDelta = b.lastActiveAt - a.lastActiveAt;
  if (activityDelta !== 0) return activityDelta;

  const updatedDelta = b.updatedAt - a.updatedAt;
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = b.createdAt - a.createdAt;
  if (createdDelta !== 0) return createdDelta;

  return b._creationTime - a._creationTime;
};

const pickPrimaryCloudDevice = (
  records: Doc<"cloud_devices">[],
): Doc<"cloud_devices"> | null => {
  if (records.length === 0) return null;
  return [...records].sort(compareCloudDevices)[0];
};

const ownerStableHash = (ownerId: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < ownerId.length; i += 1) {
    hash ^= ownerId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const buildSpriteNameForOwner = (ownerId: string): string => {
  const sanitized = ownerId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = sanitized.slice(-8) || "user";
  const stable = ownerStableHash(ownerId).slice(0, 6).padEnd(6, "0");
  return `stella-${suffix}-${stable}`;
};

const isSpriteAlreadyExistsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("sprites api post /sprites: 400") &&
    (message.includes("duplicate") ||
      message.includes("exists") ||
      message.includes("already") ||
      message.includes("name"))
  );
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

type SpritesTokenQueryCtx = {
  runQuery: ActionCtx["runQuery"];
  runMutation: ActionCtx["runMutation"];
};

const resolveManagedSpritesToken = (ownerId: string): string | null => {
  const ownerTokenMapRaw = process.env[SPRITES_OWNER_TOKEN_MAP_ENV];
  if (ownerTokenMapRaw?.trim()) {
    try {
      const parsed = JSON.parse(ownerTokenMapRaw) as unknown;
      if (parsed && typeof parsed === "object") {
        const ownerToken = (parsed as Record<string, unknown>)[ownerId];
        if (typeof ownerToken === "string" && ownerToken.trim()) {
          return ownerToken.trim();
        }
      }
    } catch (error) {
      console.warn(
        `[cloud_devices] Failed to parse ${SPRITES_OWNER_TOKEN_MAP_ENV}:`,
        error,
      );
    }
  }
  return null;
};

export const getSpritesTokenForOwner = async (
  ctx: SpritesTokenQueryCtx,
  ownerId: string,
): Promise<string> => {
  const token = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
    ownerId,
    provider: SPRITES_SECRET_PROVIDER,
  });
  if (token) {
    return token;
  }

  const managedToken = resolveManagedSpritesToken(ownerId);
  if (!managedToken) {
    throw new Error(
      `Missing Sprites API token for owner (${SPRITES_SECRET_PROVIDER}). Add an owner token entry to ${SPRITES_OWNER_TOKEN_MAP_ENV} in backend environment for automatic provisioning.`,
    );
  }

  try {
    await ctx.runMutation(internal.data.secrets.upsertManagedSecretForOwner, {
      ownerId,
      provider: SPRITES_SECRET_PROVIDER,
      label: SPRITES_MANAGED_SECRET_LABEL,
      plaintext: managedToken,
      metadata: {
        managed: true,
        source: SPRITES_OWNER_TOKEN_MAP_ENV,
      },
    });
  } catch (error) {
    console.warn(
      `[cloud_devices] Failed to persist managed ${SPRITES_SECRET_PROVIDER} for owner ${ownerId}:`,
      error,
    );
  }

  return managedToken;
};

export const spritesApi = async (
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) => {

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
export const spritesApiText = async (
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) => {
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
  token: string,
  spriteName: string,
  command: string,
): Promise<SpritesExecResult> => {
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
  token: string,
  spriteName: string,
  command: string,
  context = "Sprites command",
): Promise<SpritesExecResult> => {
  const result = await spritesExec(token, spriteName, command);
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
  handler: async (ctx, args) => {
    const runtimePreference = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", RUNTIME_MODE_KEY))
      .unique();
    const runtimeMode = normalizeRuntimeMode(runtimePreference?.value ?? null);
    if (runtimeMode !== "cloud_247") {
      return null;
    }

    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    const record = pickPrimaryCloudDevice(records);

    if (!record || record.status === "error") return null;
    return record.spriteName;
  },
});

/**
 * Resolve cloud device for owner without checking runtime_mode preference.
 * Used by channel integrations where cloud is the fallback when no local
 * device is available.
 */
export const resolveForOwnerUngated = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    const record = pickPrimaryCloudDevice(records);
    if (!record || record.status === "error") return null;
    return record.spriteName;
  },
});

export const listForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: cloudDeviceListValidator,
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
  },
});

export const listInactiveBefore = internalQuery({
  args: {
    cutoffMs: v.number(),
    limit: v.number(),
  },
  returns: cloudDeviceListValidator,
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cloud_devices")
      .withIndex("by_lastActiveAt", (q) => q.lt("lastActiveAt", args.cutoffMs))
      .order("asc")
      .take(args.limit);
  },
});

export const getForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    return pickPrimaryCloudDevice(records);
  },
});

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const touchActivity = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    const record = pickPrimaryCloudDevice(records);

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

export const deleteCloudDevicesByIds = internalMutation({
  args: {
    ids: v.array(v.id("cloud_devices")),
  },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
    return null;
  },
});

export const ensureSingleRecordForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
  },
  returns: ensureSingleRecordResultValidator,
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    const existing = pickPrimaryCloudDevice(records);

    if (existing) {
      const duplicateIds = records
        .filter((record) => record._id !== existing._id)
        .map((record) => record._id);
      for (const duplicateId of duplicateIds) {
        await ctx.db.delete(duplicateId);
      }
      return { cloudDevice: existing, created: false };
    }

    const now = Date.now();
    const deviceId = await ctx.db.insert("cloud_devices", {
      ownerId: args.ownerId,
      provider: args.provider,
      spriteName: args.spriteName,
      status: args.status,
      lastActiveAt: now,
      setupComplete: false,
      createdAt: now,
      updatedAt: now,
    });

    const cloudDevice = await ctx.db.get(deviceId);
    if (!cloudDevice) {
      throw new Error("Failed to load cloud device after insert");
    }
    return { cloudDevice, created: true };
  },
});

export const deleteCloudDevice = internalMutation({
  args: { id: v.id("cloud_devices") },
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
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const spritesToken = await getSpritesTokenForOwner(ctx, args.ownerId);
      // Install additional tools the base image may not have
      // Sprites already include: Node 22, Python 3.13, Git, sqlite3, ripgrep
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        "apt-get update -qq && apt-get install -y -qq jq curl > /dev/null 2>&1",
        "Sprite package install",
      );

      // Install Playwright Chromium for browser automation
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        "npx playwright install chromium --with-deps > /dev/null 2>&1",
        "Playwright install",
      );

      // Create isolated workspace user for agent tool execution
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        "useradd -m -d /home/workspace -s /bin/bash workspace && " +
          "chown -R workspace:workspace /home/workspace",
        "Workspace user creation",
      );

      // Create a checkpoint after setup for rollback safety
      // Checkpoint creation returns streaming NDJSON, use text variant
      const checkpointResponse = await spritesApiText(
        spritesToken,
        `/sprites/${args.spriteName}/checkpoint`,
        "POST",
        { comment: "initial-setup" },
      );
      assertNdjsonNoError(checkpointResponse, "Sprite checkpoint create");

      await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
        id: args.deviceId,
        status: "running",
        setupComplete: true,
      });
    } catch (error) {
      console.error("[cloud_devices] Setup failed:", error);
      await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
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
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();
    const mode = normalizeRuntimeMode(runtimePreference?.value ?? null);
    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .collect();
    const cloudDevice = pickPrimaryCloudDevice(records);

    return {
      mode,
      enabled: mode === "cloud_247",
      cloudDevice: cloudDevice ?? null,
    };
  },
});

export const getActive = internalQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const ownerId = identity.subject;

    const records = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .collect();
    return pickPrimaryCloudDevice(records);
  },
});

// ---------------------------------------------------------------------------
// Public Actions (for frontend)
// ---------------------------------------------------------------------------

const ensureSingleCloudDeviceForOwner = async (
  ctx: ActionCtx,
  ownerId: string,
  spritesToken?: string,
): Promise<Doc<"cloud_devices"> | null> => {
  const records = await ctx.runQuery(internal.agent.cloud_devices.listForOwner, { ownerId });
  const primary = pickPrimaryCloudDevice(records);
  if (!primary) return null;

  const duplicates = records.filter(
    (record: Doc<"cloud_devices">) => record._id !== primary._id,
  );
  if (duplicates.length === 0) return primary;

  const duplicateIds = duplicates.map((record: Doc<"cloud_devices">) => record._id);
  await ctx.runMutation(internal.agent.cloud_devices.deleteCloudDevicesByIds, { ids: duplicateIds });

  const deletedSpriteNames = new Set<string>();
  for (const duplicate of duplicates) {
    if (duplicate.spriteName === primary.spriteName || deletedSpriteNames.has(duplicate.spriteName)) {
      continue;
    }
    deletedSpriteNames.add(duplicate.spriteName);
    if (!spritesToken) {
      continue;
    }
    try {
      await spritesApi(spritesToken, `/sprites/${duplicate.spriteName}`, "DELETE");
    } catch (error) {
      console.error("[cloud_devices] Duplicate sprite deletion error (continuing):", error);
    }
  }

  return primary;
};

const ensure247ForOwner = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<Enable247Result> => {
  const spritesToken = await getSpritesTokenForOwner(ctx, ownerId);
  const existing = await ensureSingleCloudDeviceForOwner(ctx, ownerId, spritesToken);
  if (existing && existing.status !== "error") {
    await ctx.runMutation(internal.agent.cloud_devices.touchActivity, { ownerId });
    await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
      ownerId,
      key: RUNTIME_MODE_KEY,
      value: "cloud_247",
    });
    return { status: "already_enabled", spriteName: existing.spriteName };
  }

  if (existing && existing.status === "error") {
    try {
      await spritesApi(spritesToken, `/sprites/${existing.spriteName}`, "DELETE");
    } catch (error) {
      console.error("[cloud_devices] Error-state sprite deletion error (continuing):", error);
    }
    await ctx.runMutation(internal.agent.cloud_devices.deleteCloudDevice, {
      id: existing._id,
    });
  }

  const spriteName = buildSpriteNameForOwner(ownerId);
  try {
    await spritesApi(spritesToken, "/sprites", "POST", { name: spriteName });
  } catch (error) {
    if (!isSpriteAlreadyExistsError(error)) {
      throw error;
    }
  }

  const result = await ctx.runMutation(internal.agent.cloud_devices.ensureSingleRecordForOwner, {
    ownerId,
    provider: "sprites",
    spriteName,
    status: "provisioning",
  });

  if (result.created || !result.cloudDevice.setupComplete) {
    await ctx.scheduler.runAfter(0, internal.agent.cloud_devices.setupSprite, {
      deviceId: result.cloudDevice._id,
      spriteName: result.cloudDevice.spriteName,
      ownerId,
    });
  }

  await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
    ownerId,
    key: RUNTIME_MODE_KEY,
    value: "cloud_247",
  });

  return { status: "provisioning", spriteName: result.cloudDevice.spriteName };
};

const disable247ForOwner = async (
  ctx: ActionCtx,
  ownerId: string,
): Promise<Disable247Result> => {
  const record = await ensureSingleCloudDeviceForOwner(ctx, ownerId);
  if (!record) {
    await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
      ownerId,
      key: RUNTIME_MODE_KEY,
      value: "local",
    });
    return { status: "not_enabled" };
  }

  await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
    id: record._id,
    status: "stopped",
  });

  await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
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
      await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
        ownerId,
        key: RUNTIME_MODE_KEY,
        value: "local",
      });
      try {
        await ctx.runAction(api.channels.bridge.stopBridge, { provider: "whatsapp" });
      } catch {
        // Best effort: bridge may already be stopped.
      }
      try {
        await ctx.runAction(api.channels.bridge.stopBridge, { provider: "signal" });
      } catch {
        // Best effort: bridge may already be stopped.
      }
      await disable247ForOwner(ctx, ownerId);
    }

    const cloudDevice = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, { ownerId });
    return {
      mode: args.enabled ? "cloud_247" : "local",
      enabled: args.enabled,
      cloudDevice: cloudDevice ?? null,
    };
  },
});

/**
 * Internal action to spawn a cloud device for a given owner.
 * Used by the SpawnRemoteMachine backend tool.
 */
export const spawnForOwner = internalAction({
  args: { ownerId: v.string() },
  returns: enable247ResultValidator,
  handler: async (ctx, args): Promise<Enable247Result> => {
    return await ensure247ForOwner(ctx, args.ownerId);
  },
});

export const enable247 = internalAction({
  args: {},
  returns: enable247ResultValidator,
  handler: async (ctx): Promise<Enable247Result> => {
    const ownerId = await requireUserId(ctx);
    return await ensure247ForOwner(ctx, ownerId);
  },
});

export const disable247 = internalAction({
  args: {},
  returns: disable247ResultValidator,
  handler: async (ctx): Promise<Disable247Result> => {
    const ownerId = await requireUserId(ctx);
    return await disable247ForOwner(ctx, ownerId);
  },
});
