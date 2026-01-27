"use node";

import { action, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import {
  createHash,
  randomUUID,
  verify as verifySignatureRaw,
  type BinaryLike,
} from "crypto";
import type { Id } from "./_generated/dataModel";

type PackEntry = {
  virtualPath: string;
  zone: string;
  projectRelativePath: string;
  action: "add" | "update" | "delete";
  encoding?: "utf8" | "base64";
  content?: string;
  hash?: string;
  size?: number;
};

type PackBundle = {
  schemaVersion: 1;
  manifest: {
    schemaVersion: 1;
    packId: string;
    name: string;
    description: string;
    version: string;
    createdAt: number;
    authorDeviceId: string;
    authorPublicKey: string;
    changeSetIds: string[];
    baselineId?: string;
    baselineGitHead?: string | null;
    changedPaths: string[];
    zones: string[];
    compatibilityNotes: string[];
    validations: unknown[];
    validationSummary: unknown;
    securityReview: unknown;
    bundleHash: string;
    signature: string;
  };
  entries: PackEntry[];
  diffPatch?: string;
  diffPatchTruncated?: boolean;
};

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const stringify = (input: unknown): string => {
    if (input === null || typeof input !== "object") {
      return JSON.stringify(input);
    }
    if (seen.has(input as object)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(input as object);
    if (Array.isArray(input)) {
      return `[${input.map((item) => stringify(item)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const body = keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`);
    return `{${body.join(",")}}`;
  };
  return stringify(value);
};

const hashCanonicalJson = (value: unknown) => {
  const canonical = stableStringify(value);
  const hash = createHash("sha256");
  hash.update(Buffer.from(canonical, "utf-8"));
  return hash.digest("hex");
};

const bundleWithoutSignature = (bundle: PackBundle) => {
  const clone: PackBundle = JSON.parse(JSON.stringify(bundle)) as PackBundle;
  clone.manifest.bundleHash = "";
  clone.manifest.signature = "";
  clone.manifest.authorPublicKey = "";
  return clone;
};

const ensurePemKey = (value: string) =>
  value.includes("BEGIN PUBLIC KEY")
    ? value
    : `-----BEGIN PUBLIC KEY-----\n${value}\n-----END PUBLIC KEY-----`;

const verifyBundleSignature = (bundle: PackBundle) => {
  const bundleForHash = bundleWithoutSignature(bundle);
  const hashHex = hashCanonicalJson(bundleForHash);
  const keyPem = ensurePemKey(bundle.manifest.authorPublicKey);
  const signatureBytes = Buffer.from(bundle.manifest.signature, "base64");
  let signatureValid = false;
  try {
    signatureValid = verifySignatureRaw(
      null,
      Buffer.from(hashHex, "hex") as BinaryLike,
      keyPem,
      signatureBytes,
    );
  } catch {
    signatureValid = false;
  }
  return {
    hashHex,
    hashMatches: hashHex === bundle.manifest.bundleHash,
    signatureValid,
  };
};

const loadBundleFromStorage = async (ctx: ActionCtx, storageId: Id<"_storage">) => {
  const blob = await ctx.storage.get(storageId);
  if (!blob) {
    return null;
  }
  const text = await blob.text();
  try {
    return JSON.parse(text) as PackBundle;
  } catch {
    return null;
  }
};

export const upsertChannel = action({
  args: {
    channelId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(api.updates_registry.upsertChannel, args);
  },
});

export const listChannels = action({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(api.updates_registry.listChannels, {});
  },
});

export const publishRelease = action({
  args: {
    channelId: v.string(),
    releaseId: v.optional(v.string()),
    version: v.string(),
    baseGitHead: v.optional(v.string()),
    notes: v.optional(v.string()),
    bundle: v.any(),
    bundleHash: v.string(),
    signature: v.string(),
    authorPublicKey: v.string(),
    conversationId: v.optional(v.id("conversations")),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bundle = args.bundle as PackBundle;
    if (!bundle?.manifest || bundle.schemaVersion !== 1) {
      return { ok: false, reason: "Invalid bundle payload." };
    }

    const verification = verifyBundleSignature(bundle);
    if (!verification.hashMatches || !verification.signatureValid) {
      return { ok: false, reason: "Bundle signature verification failed." };
    }

    if (verification.hashHex !== args.bundleHash || bundle.manifest.bundleHash !== args.bundleHash) {
      return { ok: false, reason: "Bundle hash mismatch." };
    }
    if (
      bundle.manifest.signature !== args.signature ||
      bundle.manifest.authorPublicKey !== args.authorPublicKey
    ) {
      return { ok: false, reason: "Bundle signature metadata mismatch." };
    }

    const now = Date.now();
    const releaseId = args.releaseId?.trim() || randomUUID();

    const storageId = await ctx.storage.store(
      new Blob([stableStringify(bundle)], { type: "application/json" }),
    );

    const changedPaths = Array.isArray(bundle.manifest.changedPaths)
      ? bundle.manifest.changedPaths.slice(0, 5_000)
      : [];
    const zones = Array.isArray(bundle.manifest.zones) ? bundle.manifest.zones.slice(0, 200) : [];
    await ctx.runMutation(internal.updates_registry.upsertReleaseWithChannel, {
      channelId: args.channelId,
      releaseId,
      version: args.version,
      baseGitHead: args.baseGitHead ?? bundle.manifest.baselineGitHead ?? undefined,
      bundleStorageKey: storageId,
      bundleHash: args.bundleHash,
      signature: args.signature,
      authorPublicKey: args.authorPublicKey,
      notes: args.notes,
      manifest: bundle.manifest,
      changedPaths,
      zones,
      now,
    });

    if (args.conversationId && args.deviceId) {
      await ctx.runMutation(api.events.appendEvent, {
        conversationId: args.conversationId,
        type: "update_published",
        deviceId: args.deviceId,
        payload: {
          channelId: args.channelId,
          releaseId,
          version: args.version,
          changedPaths: changedPaths.slice(0, 200),
        },
      });
    }

    return {
      ok: true,
      channelId: args.channelId,
      releaseId,
      version: args.version,
    };
  },
});

export const getLatestRelease = action({
  args: {
    channelId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.runQuery(internal.updates_registry.resolveReleaseRecord, {
      channelId: args.channelId,
    });
    if (!record) {
      return { ok: false, channelId: args.channelId, reason: "No releases available." };
    }
    const bundle = await loadBundleFromStorage(ctx, record.bundleStorageKey as Id<"_storage">);
    if (!bundle) {
      return { ok: false, channelId: args.channelId, reason: "Release bundle missing." };
    }
    return {
      ok: true,
      channelId: args.channelId,
      release: {
        channelId: record.channelId,
        releaseId: record.releaseId,
        version: record.version,
        baseGitHead: record.baseGitHead ?? bundle.manifest.baselineGitHead ?? null,
        createdAt: record.createdAt,
        notes: record.notes,
        bundle,
      },
    };
  },
});

export const getReleaseForApply = action({
  args: {
    channelId: v.string(),
    releaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const record = await ctx.runQuery(internal.updates_registry.resolveReleaseRecord, {
      channelId: args.channelId,
      releaseId: args.releaseId,
    });
    if (!record) {
      return { ok: false, reason: "Requested release not found." };
    }
    const bundle = await loadBundleFromStorage(ctx, record.bundleStorageKey as Id<"_storage">);
    if (!bundle) {
      return { ok: false, reason: "Release bundle missing." };
    }
    return {
      ok: true,
      release: {
        channelId: record.channelId,
        releaseId: record.releaseId,
        version: record.version,
        baseGitHead: record.baseGitHead ?? bundle.manifest.baselineGitHead ?? null,
        createdAt: record.createdAt,
        notes: record.notes,
        bundle,
      },
    };
  },
});

export const recordAppliedRelease = action({
  args: {
    releaseId: v.string(),
    channelId: v.string(),
    version: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    conflicts: v.optional(v.number()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.updates_registry.recordAppliedRelease, args);
    return { ok: true };
  },
});
