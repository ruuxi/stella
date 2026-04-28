import { action, type ActionCtx } from "../_generated/server";
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

type PublishDecision = z.infer<typeof publishDecisionSchema>;

const publishDraftValidator = v.object({
  packageId: v.string(),
  category: v.union(v.literal("agents"), v.literal("stella")),
  displayName: v.string(),
  description: v.string(),
  releaseNotes: v.optional(v.string()),
  commitHashes: v.array(v.string()),
  existingPackageId: v.optional(v.string()),
  releaseNumber: v.number(),
  selectedChanges: v.array(v.object({
    commitHash: v.string(),
    shortHash: v.optional(v.string()),
    subject: v.string(),
    files: v.array(v.string()),
  })),
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

const validateCandidateInput = (args: {
  requestText: string;
  commits: unknown[];
  files: unknown[];
}) => {
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
  return requestText;
};

const resolveExistingPackage = async (
  ctx: ActionCtx,
  existingPackageIdArg: string | undefined,
): Promise<{
  existingPackageId?: string;
  existingPackage: ExistingStorePackage | null;
}> => {
  const existingPackageId = existingPackageIdArg
    ? normalizePackageId(existingPackageIdArg)
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
  return { existingPackageId, existingPackage };
};

const buildCandidate = (args: {
  requestText: string;
  selectedCommitHashes: string[];
  commits: Array<{
    commitHash: string;
    shortHash?: string;
    subject: string;
    body: string;
    timestampMs?: number;
    files: string[];
    patch: string;
    conversationId?: string;
  }>;
  files: Array<{
    path: string;
    deleted: boolean;
    contentBase64?: string;
  }>;
  existingPackageId?: string;
}): StorePublishCandidateBundle => ({
  requestText: args.requestText,
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
  ...(args.existingPackageId ? { existingPackageId: args.existingPackageId } : {}),
});

const selectCommitHashes = (
  candidate: StorePublishCandidateBundle,
  commitHashes: string[],
) => {
  const submittedHashSet = new Set(candidate.commits.map((commit) => commit.commitHash));
  const selected = commitHashes
    .map((hash) => hash.trim())
    .filter((hash) => submittedHashSet.has(hash));
  if (selected.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "The Store publish agent did not select any submitted changes.",
    });
  }
  return selected;
};

const buildDraftFromDecision = (args: {
  candidate: StorePublishCandidateBundle;
  decision: PublishDecision;
  existingPackage: ExistingStorePackage | null;
  existingPackageId?: string;
}) => {
  const packageId = args.existingPackageId ?? normalizePackageId(args.decision.packageId);
  const category: StorePackageCategory = args.existingPackage?.category
    ? normalizeStoreCategory(args.existingPackage.category)
    : normalizeStoreCategory(args.decision.category);
  const commitHashes = selectCommitHashes(args.candidate, args.decision.commitHashes);
  const commitByHash = new Map(
    args.candidate.commits.map((commit) => [commit.commitHash, commit]),
  );
  return {
    packageId,
    category,
    displayName: args.existingPackage?.displayName ?? args.decision.displayName.trim(),
    description: args.existingPackage?.description ?? args.decision.description.trim(),
    ...(args.decision.releaseNotes?.trim()
      ? { releaseNotes: args.decision.releaseNotes.trim() }
      : {}),
    commitHashes,
    ...(args.existingPackageId ? { existingPackageId: args.existingPackageId } : {}),
    releaseNumber: args.existingPackage
      ? args.existingPackage.latestReleaseNumber + 1
      : 1,
    selectedChanges: commitHashes.map((hash) => {
      const commit = commitByHash.get(hash)!;
      return {
        commitHash: commit.commitHash,
        ...(commit.shortHash ? { shortHash: commit.shortHash } : {}),
        subject: commit.subject,
        files: commit.files,
      };
    }),
  };
};

const prepareDraft = async (
  ctx: ActionCtx,
  args: {
    requestText: string;
    selectedCommitHashes: string[];
    commits: Array<{
      commitHash: string;
      shortHash?: string;
      subject: string;
      body: string;
      timestampMs?: number;
      files: string[];
      patch: string;
      conversationId?: string;
    }>;
    files: Array<{
      path: string;
      deleted: boolean;
      contentBase64?: string;
    }>;
    existingPackageId?: string;
  },
  ownerId: string,
) => {
  const requestText = validateCandidateInput(args);
  const { existingPackageId, existingPackage } = await resolveExistingPackage(
    ctx,
    args.existingPackageId,
  );
  const candidate = buildCandidate({
    ...args,
    requestText,
    ...(existingPackageId ? { existingPackageId } : {}),
  });

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

  return {
    candidate,
    existingPackage,
    draft: buildDraftFromDecision({
      candidate,
      decision: parsePublishDecision(assistantText(message)),
      existingPackage,
      existingPackageId,
    }),
  };
};

const publishDraft = async (
  ctx: ActionCtx,
  args: {
    candidate: StorePublishCandidateBundle;
    draft: {
      packageId: string;
      category: "agents" | "stella";
      displayName: string;
      description: string;
      releaseNotes?: string;
      commitHashes: string[];
      existingPackageId?: string;
      releaseNumber: number;
    };
    existingPackage: ExistingStorePackage | null;
  },
) => {
  const packageId = args.draft.existingPackageId
    ? normalizePackageId(args.draft.existingPackageId)
    : normalizePackageId(args.draft.packageId);
  const category = args.existingPackage?.category
    ? normalizeStoreCategory(args.existingPackage.category)
    : normalizeStoreCategory(args.draft.category);
  const commitHashes = selectCommitHashes(args.candidate, args.draft.commitHashes);
  const releaseNumber = args.existingPackage
    ? args.existingPackage.latestReleaseNumber + 1
    : 1;

  const artifact = buildStoreReleaseArtifactFromCandidate({
    packageId,
    releaseNumber,
    category,
    displayName: args.existingPackage?.displayName ?? args.draft.displayName.trim(),
    description: args.existingPackage?.description ?? args.draft.description.trim(),
    releaseNotes: args.draft.releaseNotes?.trim(),
    candidate: {
      ...args.candidate,
      selectedCommitHashes: commitHashes,
    },
  });

  if (args.existingPackage) {
    return await ctx.runAction(api.data.store_packages.createUpdateRelease, {
      packageId,
      releaseNotes: args.draft.releaseNotes?.trim(),
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
    displayName: args.draft.displayName.trim(),
    description: args.draft.description.trim(),
    releaseNotes: args.draft.releaseNotes?.trim(),
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
};

export const prepareCandidateRelease = action({
  args: {
    requestText: v.string(),
    selectedCommitHashes: v.array(v.string()),
    commits: v.array(candidateCommitValidator),
    files: v.array(candidateFileValidator),
    existingPackageId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const { draft } = await prepareDraft(ctx, args, ownerId);
    return draft;
  },
});

export const publishPreparedRelease = action({
  args: {
    requestText: v.string(),
    selectedCommitHashes: v.array(v.string()),
    commits: v.array(candidateCommitValidator),
    files: v.array(candidateFileValidator),
    existingPackageId: v.optional(v.string()),
    draft: publishDraftValidator,
  },
  handler: async (ctx, args): Promise<unknown> => {
    await requireSensitiveUserIdAction(ctx);
    const requestText = validateCandidateInput(args);
    const { existingPackageId, existingPackage } = await resolveExistingPackage(
      ctx,
      args.existingPackageId,
    );
    const candidate = buildCandidate({
      ...args,
      requestText,
      ...(existingPackageId ? { existingPackageId } : {}),
    });
    return await publishDraft(ctx, {
      candidate,
      draft: args.draft,
      existingPackage,
    });
  },
});

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
    const { candidate, existingPackage, draft } = await prepareDraft(ctx, args, ownerId);
    return await publishDraft(ctx, {
      candidate,
      draft,
      existingPackage,
    });
  },
});
