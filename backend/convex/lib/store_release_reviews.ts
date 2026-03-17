import { generateObject } from "ai";
import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { usageSummaryFromResult } from "../agent/model_execution";
import { resolveFallbackConfig, resolveModelConfig } from "../agent/model_resolver";
import { withModelFailoverAsync } from "../agent/model_failover";
import {
  assertManagedUsageAllowed,
  scheduleManagedUsage,
} from "./managed_billing";
import {
  buildStoreImageSafetyReviewPrompt,
  buildStoreSecurityReviewPrompt,
  STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT,
  STORE_SECURITY_REVIEW_SYSTEM_PROMPT,
} from "../prompts/store_reviews";

const reviewFindingSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(4000),
  filePaths: z.array(z.string().min(1).max(500)).max(12),
});

const storeReviewVerdictSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1).max(1500),
  blockingReason: z.string().min(1).max(1500).optional(),
  findings: z.array(reviewFindingSchema).max(12),
});

const storeReleaseArtifactSchema = z.object({
  kind: z.literal("self_mod_blueprint"),
  schemaVersion: z.literal(1),
  manifest: z.object({
    packageId: z.string(),
    featureId: z.string(),
    releaseNumber: z.number(),
    displayName: z.string(),
    description: z.string(),
    releaseNotes: z.string().optional(),
    batchIds: z.array(z.string()),
    commitHashes: z.array(z.string()),
    files: z.array(z.string()),
    createdAt: z.number(),
  }),
  applyGuidance: z.string(),
  batches: z.array(z.object({
    batchId: z.string(),
    ordinal: z.number(),
    commitHash: z.string(),
    files: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    patch: z.string(),
  })),
  files: z.array(z.object({
    path: z.string(),
    changeType: z.enum(["create", "update", "delete"]),
    deleted: z.boolean().optional(),
    referenceContentBase64: z.string().optional(),
  })),
});

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css", ".scss",
  ".sass", ".less", ".html", ".htm", ".xml", ".md", ".mdx", ".yml", ".yaml", ".toml",
  ".ini", ".conf", ".env", ".sh", ".bash", ".zsh", ".ps1", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".php", ".sql", ".gql", ".graphql", ".vue", ".svelte", ".astro",
  ".txt",
]);

const CODE_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "procfile",
]);

const MAX_PATCH_TEXT_CHARS = 18_000;
const MAX_CONTENT_TEXT_CHARS = 24_000;
const MAX_REVIEW_FAILURES_IN_MESSAGE = 4;

type ParsedStoreReleaseArtifact = z.infer<typeof storeReleaseArtifactSchema>;

type ReviewableCodeFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  contentText?: string;
  patchText?: string;
};

type ReviewableImageFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  mimeType: string;
  dataUrl: string;
};

const normalizePath = (value: string): string => value.trim().replace(/\\/g, "/");

const truncate = (value: string, maxChars: number): string =>
  value.length > maxChars ? `${value.slice(0, maxChars)}\n\n... (truncated)` : value;

const getFileExtension = (filePath: string): string => {
  const normalized = normalizePath(filePath);
  const fileName = normalized.split("/").pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
};

const getFileBasename = (filePath: string): string =>
  (normalizePath(filePath).split("/").pop() ?? normalizePath(filePath)).toLowerCase();

const isImagePath = (filePath: string): boolean =>
  Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, getFileExtension(filePath));

const isLikelyCodePath = (filePath: string): boolean =>
  CODE_EXTENSIONS.has(getFileExtension(filePath)) || CODE_FILENAMES.has(getFileBasename(filePath));

const decodeBase64ToBytes = (value: string): Uint8Array => {
  const normalized = value.replace(/\s+/g, "");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
};

const decodeBase64ToText = (value: string): string => {
  const bytes = decodeBase64ToBytes(value);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

const isProbablyText = (value: string): boolean => {
  if (!value) return false;
  if (value.includes("\u0000")) return false;
  const sample = value.slice(0, 4000);
  let readableChars = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (
      code === 9
      || code === 10
      || code === 13
      || (code >= 32 && code <= 126)
      || code >= 160
    ) {
      readableChars += 1;
    }
  }
  return readableChars / sample.length >= 0.85;
};

const buildPatchTextForFile = (
  artifact: ParsedStoreReleaseArtifact,
  filePath: string,
): string | undefined => {
  const normalizedPath = normalizePath(filePath);
  const matchingPatches = artifact.batches
    .filter((batch) =>
      batch.files.includes(normalizedPath)
      || batch.patch.includes(`a/${normalizedPath}`)
      || batch.patch.includes(`b/${normalizedPath}`),
    )
    .map((batch) => [
      `Commit ${batch.commitHash}`,
      `Subject: ${batch.subject}`,
      batch.patch,
    ].join("\n"))
    .join("\n\n");

  if (!matchingPatches.trim()) {
    return undefined;
  }
  return truncate(matchingPatches, MAX_PATCH_TEXT_CHARS);
};

const summarizeFindings = (
  verdicts: Array<{ path: string; blockingReason?: string; summary: string }>,
  prefix: string,
): string =>
  verdicts
    .slice(0, MAX_REVIEW_FAILURES_IN_MESSAGE)
    .map((verdict) => `${prefix} ${verdict.path}: ${verdict.blockingReason ?? verdict.summary}`)
    .join(" | ");

export const parseReviewableStoreArtifact = (artifactBody: string): {
  artifact: ParsedStoreReleaseArtifact;
  codeFiles: ReviewableCodeFile[];
  imageFiles: ReviewableImageFile[];
} => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(artifactBody);
  } catch {
    throw new Error("Store release artifact is not valid JSON.");
  }

  const artifact = storeReleaseArtifactSchema.parse(parsedJson);
  const codeFiles: ReviewableCodeFile[] = [];
  const imageFiles: ReviewableImageFile[] = [];

  for (const file of artifact.files) {
    const normalizedPath = normalizePath(file.path);
    const patchText = buildPatchTextForFile(artifact, normalizedPath);

    if (isImagePath(normalizedPath)) {
      if (file.deleted) {
        continue;
      }
      if (!file.referenceContentBase64) {
        throw new Error(`Image file "${normalizedPath}" is missing reference content.`);
      }
      const mimeType = IMAGE_MIME_BY_EXTENSION[getFileExtension(normalizedPath)];
      imageFiles.push({
        path: normalizedPath,
        changeType: file.changeType,
        mimeType,
        dataUrl: `data:${mimeType};base64,${file.referenceContentBase64}`,
      });
      continue;
    }

    let contentText: string | undefined;
    if (!file.deleted && file.referenceContentBase64) {
      const decodedText = decodeBase64ToText(file.referenceContentBase64);
      if (isLikelyCodePath(normalizedPath) || isProbablyText(decodedText)) {
        contentText = truncate(decodedText, MAX_CONTENT_TEXT_CHARS);
      }
    }

    if (!contentText && !patchText) {
      continue;
    }

    codeFiles.push({
      path: normalizedPath,
      changeType: file.changeType,
      ...(contentText ? { contentText } : {}),
      ...(patchText ? { patchText } : {}),
    });
  }

  return {
    artifact,
    codeFiles,
    imageFiles,
  };
};

const reviewCodeFile = async (
  ctx: Pick<ActionCtx, "runQuery" | "scheduler" | "runMutation">,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    packageId: string;
    displayName: string;
    description: string;
    releaseSummary?: string;
    file: ReviewableCodeFile;
  },
) => {
  await assertManagedUsageAllowed(ctx, args.ownerId);
  const resolvedConfig = await resolveModelConfig(ctx, "store_security_review", args.ownerId);
  const fallbackConfig = await resolveFallbackConfig(ctx, "store_security_review", args.ownerId);

  let usedFallback = false;
  const startedAt = Date.now();
  const result = await withModelFailoverAsync(
    () =>
      generateObject({
        ...resolvedConfig,
        schema: storeReviewVerdictSchema,
        schemaName: "store_security_review_verdict",
        system: STORE_SECURITY_REVIEW_SYSTEM_PROMPT,
        prompt: buildStoreSecurityReviewPrompt({
          packageId: args.packageId,
          displayName: args.displayName,
          description: args.description,
          releaseSummary: args.releaseSummary,
          filePath: args.file.path,
          changeType: args.file.changeType,
          contentText: args.file.contentText,
          patchText: args.file.patchText,
        }),
      }),
    fallbackConfig
      ? () =>
        generateObject({
          ...fallbackConfig,
          schema: storeReviewVerdictSchema,
          schemaName: "store_security_review_verdict",
          system: STORE_SECURITY_REVIEW_SYSTEM_PROMPT,
          prompt: buildStoreSecurityReviewPrompt({
            packageId: args.packageId,
            displayName: args.displayName,
            description: args.description,
            releaseSummary: args.releaseSummary,
            filePath: args.file.path,
            changeType: args.file.changeType,
            contentText: args.file.contentText,
            patchText: args.file.patchText,
          }),
        })
      : undefined,
    {
      onFallback: () => {
        usedFallback = true;
      },
    },
  );

  await scheduleManagedUsage(ctx, {
    ownerId: args.ownerId,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    agentType: "service:store_security_review",
    model: usedFallback && fallbackConfig ? fallbackConfig.model : resolvedConfig.model,
    durationMs: Date.now() - startedAt,
    success: true,
    usage: usageSummaryFromResult(result),
  });

  return result.object;
};

const reviewImageFile = async (
  ctx: Pick<ActionCtx, "runQuery" | "scheduler" | "runMutation">,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    packageId: string;
    displayName: string;
    description: string;
    releaseSummary?: string;
    file: ReviewableImageFile;
  },
) => {
  await assertManagedUsageAllowed(ctx, args.ownerId);
  const resolvedConfig = await resolveModelConfig(ctx, "store_image_safety_review", args.ownerId);
  const fallbackConfig = await resolveFallbackConfig(ctx, "store_image_safety_review", args.ownerId);

  const messages = [{
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: buildStoreImageSafetyReviewPrompt({
          packageId: args.packageId,
          displayName: args.displayName,
          description: args.description,
          releaseSummary: args.releaseSummary,
          filePath: args.file.path,
          changeType: args.file.changeType,
        }),
      },
      {
        type: "image" as const,
        image: args.file.dataUrl,
      },
    ],
  }];

  let usedFallback = false;
  const startedAt = Date.now();
  const result = await withModelFailoverAsync(
    () =>
      generateObject({
        ...resolvedConfig,
        schema: storeReviewVerdictSchema,
        schemaName: "store_image_safety_review_verdict",
        system: STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT,
        messages,
      }),
    fallbackConfig
      ? () =>
        generateObject({
          ...fallbackConfig,
          schema: storeReviewVerdictSchema,
          schemaName: "store_image_safety_review_verdict",
          system: STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT,
          messages,
        })
      : undefined,
    {
      onFallback: () => {
        usedFallback = true;
      },
    },
  );

  await scheduleManagedUsage(ctx, {
    ownerId: args.ownerId,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    agentType: "service:store_image_safety_review",
    model: usedFallback && fallbackConfig ? fallbackConfig.model : resolvedConfig.model,
    durationMs: Date.now() - startedAt,
    success: true,
    usage: usageSummaryFromResult(result),
  });

  return result.object;
};

export const enforceStoreReleaseReviewOrThrow = async (
  ctx: Pick<ActionCtx, "runQuery" | "scheduler" | "runMutation">,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    packageId: string;
    displayName: string;
    description: string;
    releaseSummary?: string;
    artifactBody: string;
  },
): Promise<void> => {
  let parsedArtifact: ReturnType<typeof parseReviewableStoreArtifact>;
  try {
    parsedArtifact = parseReviewableStoreArtifact(args.artifactBody);
  } catch (error) {
    console.error("[store-review] Failed to parse artifact for review:", error);
    throw new ConvexError({
      code: "STORE_REVIEW_FAILED",
      message: "Store publish was denied because automated review could not inspect the release artifact.",
    });
  }

  try {
    const blockedCodeFiles: Array<{ path: string; blockingReason?: string; summary: string }> = [];
    for (const file of parsedArtifact.codeFiles) {
      const verdict = await reviewCodeFile(ctx, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        packageId: args.packageId,
        displayName: args.displayName,
        description: args.description,
        releaseSummary: args.releaseSummary,
        file,
      });
      if (!verdict.approved) {
        blockedCodeFiles.push({
          path: file.path,
          blockingReason: verdict.blockingReason,
          summary: verdict.summary,
        });
      }
    }

    const blockedImageFiles: Array<{ path: string; blockingReason?: string; summary: string }> = [];
    for (const file of parsedArtifact.imageFiles) {
      const verdict = await reviewImageFile(ctx, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        packageId: args.packageId,
        displayName: args.displayName,
        description: args.description,
        releaseSummary: args.releaseSummary,
        file,
      });
      if (!verdict.approved) {
        blockedImageFiles.push({
          path: file.path,
          blockingReason: verdict.blockingReason,
          summary: verdict.summary,
        });
      }
    }

    if (blockedCodeFiles.length > 0 || blockedImageFiles.length > 0) {
      const reasonParts: string[] = [];
      if (blockedCodeFiles.length > 0) {
        reasonParts.push(summarizeFindings(blockedCodeFiles, "Security review blocked"));
      }
      if (blockedImageFiles.length > 0) {
        reasonParts.push(summarizeFindings(blockedImageFiles, "Image safety review blocked"));
      }
      throw new ConvexError({
        code: "STORE_REVIEW_REJECTED",
        message: `Store publish was denied by automated review. ${reasonParts.join(" | ")}`,
      });
    }
  } catch (error) {
    if (error instanceof ConvexError) {
      throw error;
    }
    console.error("[store-review] Automated review failed:", error);
    throw new ConvexError({
      code: "STORE_REVIEW_FAILED",
      message: "Store publish was denied because automated review could not complete.",
    });
  }
};
