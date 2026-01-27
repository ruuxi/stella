"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { streamText } from "ai";
import { createHash, verify as verifySignature } from "crypto";
import { api, internal } from "./_generated/api";

type PackBundle = {
  schemaVersion: number;
  manifest: Record<string, unknown>;
  entries: unknown[];
  diffPatch?: string;
  diffPatchTruncated?: boolean;
};

type SecurityReviewResult = {
  status: "approved" | "rejected" | "needs_changes";
  summary: string;
  findings: string[];
  reviewedAt: number;
};

const stableSort = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSort(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const next: Record<string, unknown> = {};
  for (const key of keys) {
    next[key] = stableSort(record[key]);
  }
  return next;
};

const stableStringify = (value: unknown) => JSON.stringify(stableSort(value));

const bundleWithoutSignature = (bundle: PackBundle) => {
  const clone = JSON.parse(JSON.stringify(bundle)) as PackBundle;
  if (clone.manifest) {
    clone.manifest.bundleHash = "";
    clone.manifest.signature = "";
    clone.manifest.authorPublicKey = "";
  }
  return clone;
};

const hashCanonicalJson = (value: unknown) => {
  const canonical = stableStringify(value);
  const hash = createHash("sha256");
  hash.update(canonical, "utf-8");
  return {
    canonical,
    hashHex: hash.digest("hex"),
  };
};

const verifyBundleSignature = (bundle: PackBundle, authorPublicKey: string, signature: string) => {
  const hashed = hashCanonicalJson(bundleWithoutSignature(bundle));
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      null,
      Buffer.from(hashed.hashHex, "hex"),
      authorPublicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  return {
    hashHex: hashed.hashHex,
    signatureValid,
  };
};

const scrubProviderNames = (value: string) => {
  return value
    .replace(/openai|anthropic|claude|gpt-?\d*|gemini|llama|mistral/gi, "model")
    .replace(/\bprovider\b/gi, "service");
};

const parseSecurityReview = (rawText: string): SecurityReviewResult => {
  const trimmed = rawText.trim();
  const tryParse = (text: string) => {
    try {
      return JSON.parse(text) as SecurityReviewResult;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  const extracted =
    direct ??
    (() => {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        return null;
      }
      return tryParse(trimmed.slice(start, end + 1));
    })();

  if (!extracted || !extracted.status) {
    return {
      status: "needs_changes",
      summary: "Security review could not be parsed.",
      findings: ["Security review output was not valid JSON."],
      reviewedAt: Date.now(),
    };
  }

  const findings = Array.isArray(extracted.findings)
    ? extracted.findings.map((item) => scrubProviderNames(String(item)))
    : [];
  return {
    status:
      extracted.status === "approved" || extracted.status === "rejected"
        ? extracted.status
        : "needs_changes",
    summary: scrubProviderNames(String(extracted.summary ?? "Security review completed.")),
    findings,
    reviewedAt: Date.now(),
  };
};

export const securityReviewBundle = action({
  args: {
    bundle: v.any(),
  },
  handler: async (_ctx, args): Promise<SecurityReviewResult> => {
    const model = process.env.AI_GATEWAY_MODEL;
    if (!model) {
      return {
        status: "needs_changes",
        summary: "Security review is unavailable because the gateway model is not configured.",
        findings: ["Model not configured."],
        reviewedAt: Date.now(),
      };
    }

    const systemPrompt = [
      "You are the Stellar store security reviewer.",
      "Review the provided pack bundle summary for safety and policy compliance.",
      "Reject anything that appears to exfiltrate data, execute unsafe shell commands, or bypass device routing.",
      "Ensure screens remain right-panel-only.",
      "Return strict JSON only with fields: status, summary, findings.",
      "status must be one of: approved, rejected, needs_changes.",
    ].join("\n");

    const userPrompt = [
      "Pack bundle summary (JSON):",
      stableStringify(args.bundle),
    ].join("\n\n");

    try {
      const result = await streamText({
        model,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
          },
        ],
      });
      const text = await result.text;
      return parseSecurityReview(text);
    } catch (error) {
      return {
        status: "needs_changes",
        summary: "Security review failed to execute.",
        findings: [scrubProviderNames((error as Error).message)],
        reviewedAt: Date.now(),
      };
    }
  },
});

export const publishVersion = action({
  args: {
    packId: v.string(),
    name: v.string(),
    description: v.string(),
    version: v.string(),
    manifest: v.any(),
    bundle: v.any(),
    bundleHash: v.string(),
    signature: v.string(),
    authorPublicKey: v.string(),
    securityReview: v.any(),
    conversationId: v.optional(v.id("conversations")),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const review = args.securityReview as SecurityReviewResult | null;
    if (!review || review.status !== "approved") {
      return {
        ok: false,
        reason: "Security review did not approve this pack.",
      };
    }

    const bundle = args.bundle as PackBundle;
    const verification = verifyBundleSignature(bundle, args.authorPublicKey, args.signature);
    if (verification.hashHex !== args.bundleHash) {
      return {
        ok: false,
        reason: "Bundle hash mismatch.",
      };
    }
    if (!verification.signatureValid) {
      return {
        ok: false,
        reason: "Bundle signature verification failed.",
      };
    }

    const bundleJson = stableStringify(bundle);
    const blob = new Blob([bundleJson], { type: "application/json" });
    const bundleStorageKey = await ctx.storage.store(blob);

    const now = Date.now();

    const manifest = args.manifest as Record<string, unknown>;
    const changedPaths = Array.isArray(manifest.changedPaths)
      ? manifest.changedPaths.map((item) => String(item)).slice(0, 5_000)
      : [];
    const zones = Array.isArray(manifest.zones)
      ? manifest.zones.map((item) => String(item)).slice(0, 200)
      : [];
    const compatibilityNotes = Array.isArray(manifest.compatibilityNotes)
      ? manifest.compatibilityNotes.map((item) => String(item)).slice(0, 500)
      : [];

    await ctx.runMutation(internal.packs_registry.upsertPackAndVersion, {
      packId: args.packId,
      name: args.name,
      description: args.description,
      authorPublicKey: args.authorPublicKey,
      version: args.version,
      manifest: args.manifest,
      bundleStorageKey,
      bundleHash: args.bundleHash,
      signature: args.signature,
      securityReview: review,
      changedPaths,
      zones,
      compatibilityNotes,
      now,
    });

    if (args.conversationId && args.deviceId) {
      await ctx.runMutation(api.events.appendEvent, {
        conversationId: args.conversationId,
        type: "pack_published",
        deviceId: args.deviceId,
        payload: {
          packId: args.packId,
          version: args.version,
          bundleHash: args.bundleHash,
        },
      });
    }

    return {
      ok: true,
      bundleStorageKey,
      bundleHash: args.bundleHash,
    };
  },
});

export const getBundleForInstall = action({
  args: {
    packId: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.runQuery(internal.packs_registry.getPackVersionByKey, {
      packId: args.packId,
      version: args.version,
    });
    if (!record) {
      return { ok: false, reason: "Pack version not found." };
    }

    try {
      const blob = await ctx.storage.get(record.bundleStorageKey);
      if (!blob) {
        return { ok: false, reason: "Pack bundle not found in storage." };
      }
      const text = await blob.text();
      const bundle = JSON.parse(text);
      return { ok: true, bundle };
    } catch {
      return { ok: false, reason: "Failed to load or parse pack bundle." };
    }
  },
});

export const recordInstallation = action({
  args: {
    installId: v.string(),
    packId: v.string(),
    version: v.string(),
    status: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    bundleHash: v.optional(v.string()),
    signature: v.optional(v.string()),
    authorPublicKey: v.optional(v.string()),
    changedPaths: v.optional(v.array(v.string())),
    zones: v.optional(v.array(v.string())),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(api.packs_registry.recordInstallation, args);
  },
});

export const safeModeDisabled = action({
  args: {
    reason: v.string(),
    disabledAt: v.number(),
    packIds: v.array(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(api.packs_registry.safeModeDisabled, args);
  },
});

export const listPacks = action({
  args: {},
  handler: async (ctx) => await ctx.runQuery(api.packs_registry.listPacks, {}),
});
