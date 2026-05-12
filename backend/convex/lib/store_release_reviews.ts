import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getModeConfig } from "../agent/model";
import { withModelFailoverAsync } from "../agent/model_failover";
import { scheduleManagedUsage } from "./managed_billing";
import {
  buildStoreImageSafetyReviewPrompt,
  buildStoreSecurityReviewPrompt,
  STORE_BLUEPRINT_REVIEW_SYSTEM_PROMPT,
  STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT,
  STORE_SECURITY_REVIEW_SYSTEM_PROMPT,
} from "../prompts/store_reviews";
import { extractJsonBlock } from "./json";
import { truncateWithNotice } from "./text_utils";
import {
  assistantText,
  completeManagedChat,
  type ManagedModelConfig,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

const STANDARD_REVIEW = getModeConfig("standard");

const STORE_REVIEW_MODEL_CONFIG: ManagedModelConfig = {
  model: STANDARD_REVIEW.model,
  managedGatewayProvider: STANDARD_REVIEW.managedGatewayProvider,
  temperature: STANDARD_REVIEW.temperature,
  maxOutputTokens: STANDARD_REVIEW.maxOutputTokens,
  providerOptions: STANDARD_REVIEW.providerOptions as ManagedModelConfig["providerOptions"],
  modalitiesInput: ["text", "image"],
};

const reviewFindingSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(4000),
  filePaths: z.array(z.string().min(1).max(500)).max(12),
});

const storeReviewVerdictSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1).max(1500),
  blockingReason: z.string().min(1).max(1500).nullable().optional()
    .transform((value) => value ?? undefined),
  findings: z.array(reviewFindingSchema).max(12),
});

const STORE_REVIEW_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "store_review_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        approved: { type: "boolean" },
        summary: { type: "string", minLength: 1, maxLength: 1500 },
        blockingReason: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 1500,
        },
        findings: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              severity: {
                type: "string",
                enum: ["low", "medium", "high", "critical"],
              },
              title: { type: "string", minLength: 1, maxLength: 200 },
              rationale: { type: "string", minLength: 1, maxLength: 4000 },
              filePaths: {
                type: "array",
                maxItems: 12,
                items: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
            required: ["severity", "title", "rationale", "filePaths"],
          },
        },
      },
      required: ["approved", "summary", "blockingReason", "findings"],
    },
  },
} as const;

const storeReleaseArtifactSchema = z.object({
  kind: z.literal("self_mod_blueprint"),
  schemaVersion: z.literal(1),
  manifest: z.object({
    packageId: z.string(),
    releaseNumber: z.number(),
    category: z.enum(["agents", "stella"]).optional(),
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
type ParsedBlueprintMarkdownArtifact = {
  kind: "blueprint_markdown";
  schemaVersion: 2;
  blueprintMarkdown: string;
};
type ParsedReviewableStoreArtifact =
  | ParsedStoreReleaseArtifact
  | ParsedBlueprintMarkdownArtifact;

type ReviewableCodeFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  contentText?: string;
  patchText?: string;
  /**
   * "blueprint" marks a Stella Store blueprint markdown document — it is
   * instructions (plus embedded code snippets) that another user's local
   * Stella agent will implement. The reviewer uses a framing that covers
   * both the snippets AND the natural-language / prompt-injection risk
   * surface. Undefined means a normal code file (legacy v1 release path).
   */
  kind?: "blueprint";
};

type ReviewableImageFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  mimeType: string;
  dataUrl: string;
};

const normalizePath = (value: string): string => value.trim().replace(/\\/g, "/");

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
  return truncateWithNotice(matchingPatches, MAX_PATCH_TEXT_CHARS);
};

const summarizeFindings = (
  verdicts: Array<{ path: string; blockingReason?: string; summary: string }>,
  prefix: string,
): string =>
  verdicts
    .slice(0, MAX_REVIEW_FAILURES_IN_MESSAGE)
    .map((verdict) => `${prefix} ${verdict.path}: ${verdict.blockingReason ?? verdict.summary}`)
    .join(" | ");

const STORE_REVIEW_OUTPUT_INSTRUCTIONS = [
  "Return JSON only. Do not wrap it in markdown.",
  "Use this exact shape:",
  "{",
  '  "approved": boolean,',
  '  "summary": string,',
  '  "blockingReason": string | null,',
  '  "findings": [',
  "    {",
  '      "severity": "low" | "medium" | "high" | "critical",',
  '      "title": string,',
  '      "rationale": string,',
  '      "filePaths": string[]',
  "    }",
  "  ]",
  "}",
].join("\n");

const parseStoreReviewVerdictFromText = (text: string) => {
  const jsonBlock = extractJsonBlock(text) ?? text.trim();
  return storeReviewVerdictSchema.parse(JSON.parse(jsonBlock));
};

class StoreReviewAttemptError extends Error {
  readonly model: string;
  readonly reviewMessage?: Awaited<ReturnType<typeof completeManagedChat>>;
  readonly cause?: unknown;

  constructor(
    model: string,
    cause: unknown,
    reviewMessage?: Awaited<ReturnType<typeof completeManagedChat>>,
  ) {
    super(cause instanceof Error ? cause.message : "Store review failed");
    this.name = "StoreReviewAttemptError";
    this.model = model;
    this.reviewMessage = reviewMessage;
    this.cause = cause;
  }
}

const logStoreReviewUsage = async (
  ctx: Pick<ActionCtx, "scheduler">,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    agentType: "service:store_security_review" | "service:store_image_safety_review";
    message?: Awaited<ReturnType<typeof completeManagedChat>>;
    model: string;
    startedAt: number;
    success: boolean;
  },
) => {
  await scheduleManagedUsage(ctx, {
    ownerId: args.ownerId,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    agentType: args.agentType,
    model: args.model,
    durationMs: Date.now() - args.startedAt,
    success: args.success,
    ...(args.message ? { usage: usageSummaryFromAssistant(args.message) } : {}),
  });
};

const completeStoreReviewVerdict = async (
  ctx: Pick<ActionCtx, "scheduler">,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    agentType: "service:store_security_review" | "service:store_image_safety_review";
    context: Parameters<typeof completeManagedChat>[0]["context"];
    config: Parameters<typeof completeManagedChat>[0]["config"];
    fallbackConfig?: Parameters<typeof completeManagedChat>[0]["fallbackConfig"];
  },
) => {
  const executeAttempt = async (
    config: Parameters<typeof completeManagedChat>[0]["config"],
  ) => {
    let message: Awaited<ReturnType<typeof completeManagedChat>> | undefined;
    try {
      message = await completeManagedChat({
        config,
        context: args.context,
        api: "openai-completions",
        request: {
          responseFormat: STORE_REVIEW_RESPONSE_FORMAT,
        },
      });
      return {
        message,
        verdict: parseStoreReviewVerdictFromText(assistantText(message)),
      };
    } catch (error) {
      throw new StoreReviewAttemptError(message?.model ?? config.model, error, message);
    }
  };

  const startedAt = Date.now();
  try {
    const result = await withModelFailoverAsync(
      () => executeAttempt(args.config),
      args.fallbackConfig ? () => executeAttempt(args.fallbackConfig!) : undefined,
    );
    await logStoreReviewUsage(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      message: result.message,
      model: result.message.model,
      startedAt,
      success: true,
    });
    return result.verdict;
  } catch (error) {
    const reviewError = error instanceof StoreReviewAttemptError ? error : undefined;
    await logStoreReviewUsage(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      ...(reviewError?.reviewMessage ? { message: reviewError.reviewMessage } : {}),
      model: reviewError?.model ?? args.config.model,
      startedAt,
      success: false,
    });
    console.warn("[store-review] Review attempt failed:", error);
    throw error;
  }
};

type StoreReleaseCommitForReview = {
  hash: string;
  subject: string;
  diff: string;
};

const MAX_COMMIT_DIFF_LENGTH_FOR_REVIEW = 24_000;
const MAX_COMMITS_TOTAL_LENGTH_FOR_REVIEW = 120_000;

/**
 * Render the per-commit reference diffs into a single appendix the
 * reviewer reads alongside the behaviour spec. Per-commit and total
 * caps keep the prompt bounded; if a release ships more diff than fits
 * we annotate the truncation so the reviewer can still draw a verdict.
 */
const renderCommitsAppendix = (
  commits: ReadonlyArray<StoreReleaseCommitForReview>,
): string => {
  if (commits.length === 0) return "";
  const sections: string[] = [];
  let totalLength = 0;
  let truncated = false;
  for (const commit of commits) {
    if (truncated) break;
    const remaining = MAX_COMMITS_TOTAL_LENGTH_FOR_REVIEW - totalLength;
    if (remaining <= 0) {
      sections.push("Additional reference commits omitted (over total limit).");
      truncated = true;
      break;
    }
    const perCommitLimit = Math.min(remaining, MAX_COMMIT_DIFF_LENGTH_FOR_REVIEW);
    const diff = commit.diff.length <= perCommitLimit
      ? commit.diff
      : `${commit.diff.slice(0, perCommitLimit)}\n... [truncated]`;
    const block = [
      `### Commit ${commit.hash}`,
      `Subject: ${commit.subject}`,
      "",
      diff,
    ].join("\n");
    sections.push(block);
    totalLength += diff.length;
  }
  return sections.join("\n\n");
};

const buildMarkdownBlueprintReview = (
  blueprintMarkdown: string,
  commits?: ReadonlyArray<StoreReleaseCommitForReview>,
): {
  artifact: ParsedBlueprintMarkdownArtifact;
  codeFiles: ReviewableCodeFile[];
  imageFiles: ReviewableImageFile[];
} => {
  const commitsAppendix = renderCommitsAppendix(commits ?? []);
  const reviewerInput = commitsAppendix
    ? [
        "# Behaviour spec",
        "",
        blueprintMarkdown,
        "",
        "# Reference commits (author's tree)",
        "",
        commitsAppendix,
      ].join("\n")
    : blueprintMarkdown;
  return {
    artifact: {
      kind: "blueprint_markdown",
      schemaVersion: 2,
      blueprintMarkdown,
    },
    codeFiles: [{
      path: "blueprint.md",
      changeType: "update",
      contentText: reviewerInput,
      kind: "blueprint",
    }],
    imageFiles: [],
  };
};

export const parseReviewableStoreArtifact = (
  artifactBody: string,
  commits?: ReadonlyArray<StoreReleaseCommitForReview>,
): {
  artifact: ParsedReviewableStoreArtifact;
  codeFiles: ReviewableCodeFile[];
  imageFiles: ReviewableImageFile[];
} => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(artifactBody);
  } catch {
    const markdown = artifactBody.trim();
    if (!markdown) {
      throw new Error("Store release artifact is empty.");
    }
    return buildMarkdownBlueprintReview(markdown, commits);
  }

  if (parsedJson && typeof parsedJson === "object") {
    const record = parsedJson as Record<string, unknown>;
    if (record.kind === "blueprint" && record.schemaVersion === 2) {
      if (typeof record.blueprintMarkdown !== "string") {
        throw new Error("Store release blueprint markdown is missing.");
      }
      const markdown = record.blueprintMarkdown.trim();
      if (!markdown) {
        throw new Error("Store release blueprint is empty.");
      }
      return buildMarkdownBlueprintReview(markdown, commits);
    }
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
        contentText = truncateWithNotice(decodedText, MAX_CONTENT_TEXT_CHARS);
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
  return await completeStoreReviewVerdict(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: "service:store_security_review",
    config: STORE_REVIEW_MODEL_CONFIG,
    context: {
      systemPrompt: [
        args.file.kind === "blueprint"
          ? STORE_BLUEPRINT_REVIEW_SYSTEM_PROMPT
          : STORE_SECURITY_REVIEW_SYSTEM_PROMPT,
        "",
        STORE_REVIEW_OUTPUT_INSTRUCTIONS,
      ].join("\n"),
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: buildStoreSecurityReviewPrompt({
            packageId: args.packageId,
            displayName: args.displayName,
            description: args.description,
            releaseSummary: args.releaseSummary,
            filePath: args.file.path,
            changeType: args.file.changeType,
            contentText: args.file.contentText,
            patchText: args.file.patchText,
            ...(args.file.kind === "blueprint" ? { kind: "blueprint" as const } : {}),
          }),
        }],
        timestamp: Date.now(),
      }],
    },
  });
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
  const imageMatch = args.file.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!imageMatch) {
    throw new Error(`Image file "${args.file.path}" is not a valid data URL.`);
  }

  return await completeStoreReviewVerdict(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: "service:store_image_safety_review",
    config: STORE_REVIEW_MODEL_CONFIG,
    context: {
      systemPrompt: [
        STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT,
        "",
        STORE_REVIEW_OUTPUT_INSTRUCTIONS,
      ].join("\n"),
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
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
            type: "image",
            mimeType: imageMatch[1],
            data: imageMatch[2],
          },
        ],
        timestamp: Date.now(),
      }],
    },
  });
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
    commits?: ReadonlyArray<StoreReleaseCommitForReview>;
  },
): Promise<void> => {
  let parsedArtifact: ReturnType<typeof parseReviewableStoreArtifact>;
  try {
    parsedArtifact = parseReviewableStoreArtifact(args.artifactBody, args.commits);
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
