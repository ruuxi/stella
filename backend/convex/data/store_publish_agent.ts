import { action } from "../_generated/server";
import { api } from "../_generated/api";
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { requireSensitiveUserIdAction } from "../auth";
import { resolveManagedModelConfigs } from "../agent/model_resolver";
import {
  assistantText,
  completeManagedChat,
} from "../runtime_ai/managed";
import { extractJsonBlock } from "../lib/json";
import { truncateWithNotice } from "../lib/text_utils";
import {
  buildStoreReleaseArtifactFromCandidate,
  normalizeStoreCategory,
  type StorePackageCategory,
  type StorePublishCandidateBundle,
} from "../lib/store_artifacts";
import {
  buildStorePublishPrompt,
  STORE_PUBLISH_SYSTEM_PROMPT,
} from "../prompts/store_publish";

const MAX_COMMITS = 50;
const MAX_FILES = 512;
const MAX_PATCH_CHARS_PER_COMMIT = 24_000;
const MAX_BODY_CHARS = 4_000;

type ExistingStorePackage = {
  packageId: string;
  category?: "agents" | "stella";
  displayName: string;
  description: string;
  latestReleaseNumber: number;
};

const candidateCommitValidator = v.object({
  commitHash: v.string(),
  shortHash: v.optional(v.string()),
  subject: v.string(),
  body: v.string(),
  timestampMs: v.optional(v.number()),
  files: v.array(v.string()),
  patch: v.string(),
  conversationId: v.optional(v.string()),
});

const candidateFileValidator = v.object({
  path: v.string(),
  deleted: v.boolean(),
  contentBase64: v.optional(v.string()),
});

const publishDecisionSchema = z.object({
  packageId: z.string().min(1).max(64),
  category: z.enum(["agents", "stella"]),
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  releaseNotes: z.string().min(1).max(4000).optional(),
  commitHashes: z.array(z.string().min(1)).min(1).max(MAX_COMMITS),
});

const normalizePackageId = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const formatCandidateCommits = (candidate: StorePublishCandidateBundle) =>
  candidate.commits
    .slice(0, MAX_COMMITS)
    .map((commit, index) =>
      [
        `Change ${index + 1}`,
        `hash: ${commit.commitHash}`,
        `selected: ${candidate.selectedCommitHashes.includes(commit.commitHash) ? "yes" : "no"}`,
        `subject: ${commit.subject}`,
        commit.body.trim()
          ? `body: ${truncateWithNotice(commit.body, MAX_BODY_CHARS)}`
          : "body: (none)",
        `files: ${commit.files.slice(0, 40).join(", ")}`,
        "patch:",
        truncateWithNotice(commit.patch, MAX_PATCH_CHARS_PER_COMMIT),
      ].join("\n"),
    )
    .join("\n\n");

const parsePublishDecision = (text: string) => {
  const json = extractJsonBlock(text) ?? text.trim();
  return publishDecisionSchema.parse(JSON.parse(json));
};

export const publishCandidateRelease = action({
  args: {
    requestText: v.string(),
    selectedCommitHashes: v.array(v.string()),
    commits: v.array(candidateCommitValidator),
    files: v.array(candidateFileValidator),
    existingPackageId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const requestText = args.requestText.trim();
    if (!requestText) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Publish request is required.",
      });
    }
    if (args.commits.length === 0 || args.commits.length > MAX_COMMITS) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Publish candidate must include 1-${MAX_COMMITS} changes.`,
      });
    }
    if (args.files.length > MAX_FILES) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Publish candidate includes too many files; maximum is ${MAX_FILES}.`,
      });
    }

    const existingPackageId = args.existingPackageId
      ? normalizePackageId(args.existingPackageId)
      : undefined;
    const existingPackage: ExistingStorePackage | null = existingPackageId
      ? await ctx.runQuery(api.data.store_packages.getPackage, {
          packageId: existingPackageId,
        }) as ExistingStorePackage | null
      : null;
    if (existingPackageId && !existingPackage) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Store package not found",
      });
    }

    const candidate: StorePublishCandidateBundle = {
      requestText,
      selectedCommitHashes: args.selectedCommitHashes.map((hash) => hash.trim()).filter(Boolean),
      commits: args.commits.map((commit) => ({
        commitHash: commit.commitHash.trim(),
        ...(commit.shortHash ? { shortHash: commit.shortHash.trim() } : {}),
        subject: commit.subject.trim() || "Stella update",
        body: commit.body,
        ...(typeof commit.timestampMs === "number" ? { timestampMs: commit.timestampMs } : {}),
        files: commit.files.map((file) => file.trim()).filter(Boolean),
        patch: commit.patch,
        ...(commit.conversationId ? { conversationId: commit.conversationId } : {}),
      })),
      files: args.files.map((file) => ({
        path: file.path.trim(),
        deleted: file.deleted,
        ...(file.contentBase64 ? { contentBase64: file.contentBase64 } : {}),
      })),
      ...(existingPackageId ? { existingPackageId } : {}),
    };

    const { config, fallbackConfig } = await resolveManagedModelConfigs(
      ctx,
      "store_publish",
      ownerId,
    );
    const message = await completeManagedChat({
      config,
      fallbackConfig,
      context: {
        systemPrompt: STORE_PUBLISH_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: buildStorePublishPrompt({
              requestText,
              existingPackageId,
              latestReleaseNumber: existingPackage?.latestReleaseNumber,
              existingDisplayName: existingPackage?.displayName,
              existingDescription: existingPackage?.description,
              commitsText: formatCandidateCommits(candidate),
            }),
          }],
          timestamp: Date.now(),
        }],
      },
    });

    const decision = parsePublishDecision(assistantText(message));
    const packageId = existingPackageId ?? normalizePackageId(decision.packageId);
    const category: StorePackageCategory = existingPackage?.category
      ? normalizeStoreCategory(existingPackage.category)
      : normalizeStoreCategory(decision.category);
    const releaseNumber = existingPackage
      ? existingPackage.latestReleaseNumber + 1
      : 1;

    const selectedHashSet = new Set(candidate.commits.map((commit) => commit.commitHash));
    const commitHashes = decision.commitHashes
      .map((hash) => hash.trim())
      .filter((hash) => selectedHashSet.has(hash));
    if (commitHashes.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "The Store publish agent did not select any submitted changes.",
      });
    }

    const artifact = buildStoreReleaseArtifactFromCandidate({
      packageId,
      releaseNumber,
      category,
      displayName: existingPackage?.displayName ?? decision.displayName.trim(),
      description: existingPackage?.description ?? decision.description.trim(),
      releaseNotes: decision.releaseNotes?.trim(),
      candidate: {
        ...candidate,
        selectedCommitHashes: commitHashes,
      },
    });

    if (existingPackage) {
      return await ctx.runAction(api.data.store_packages.createUpdateRelease, {
        packageId,
        releaseNotes: decision.releaseNotes?.trim(),
        manifest: {
          includedBatchIds: artifact.manifest.batchIds,
          includedCommitHashes: artifact.manifest.commitHashes,
          changedFiles: artifact.manifest.files,
          category,
          ...(artifact.manifest.releaseNotes
            ? { summary: artifact.manifest.releaseNotes }
            : {}),
        },
        artifactBody: JSON.stringify(artifact),
        artifactContentType: "application/json",
      });
    }

    return await ctx.runAction(api.data.store_packages.createFirstRelease, {
      packageId,
      category,
      displayName: decision.displayName.trim(),
      description: decision.description.trim(),
      releaseNotes: decision.releaseNotes?.trim(),
      manifest: {
        includedBatchIds: artifact.manifest.batchIds,
        includedCommitHashes: artifact.manifest.commitHashes,
        changedFiles: artifact.manifest.files,
        category,
        ...(artifact.manifest.releaseNotes
          ? { summary: artifact.manifest.releaseNotes }
          : {}),
      },
      artifactBody: JSON.stringify(artifact),
      artifactContentType: "application/json",
    });
  },
});
