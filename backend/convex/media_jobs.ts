import { ConvexError, type Value, v } from "convex/values";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type {
  MediaGenerateRequest,
  MediaRequestSummary,
  MediaJobStatus,
  MediaSourceReference,
} from "./media_contract";
import {
  mediaJobErrorValidator,
  mediaJobBillingValidator,
  mediaJobResponseValidator,
  mediaRequestSummaryValidator,
} from "./schema/media";
import { isRecord, jsonValueValidator, optionalJsonValueValidator } from "./shared_validators";

export const PUBLIC_MEDIA_TEST_OWNER_ID = "__public_media_test__";

export const isMediaPublicTestModeEnabled = (): boolean =>
  process.env.MEDIA_PUBLIC_TEST_MODE?.trim() === "1";

type MediaRequestSourceSummary = {
  kind: "url" | "data_uri" | "base64_object";
  mimeType?: string;
  url?: string;
};

type StoredMediaRequestSummary = MediaRequestSummary & {
  input?: Record<string, Value>;
};

const redactLargeString = (value: string): string => {
  const trimmed = value.trim();
  if (/^data:[^;,\s]+;base64,/i.test(trimmed)) {
    return "[data-uri omitted]";
  }
  if (trimmed.length > 2048 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return "[base64 omitted]";
  }
  return trimmed;
};

const sanitizeJsonValue = (value: unknown, depth = 0): Value => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return redactLargeString(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 6) {
      return [];
    }
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= 6) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        sanitizeJsonValue(entryValue, depth + 1),
      ]),
    );
  }
  return String(value);
};

const toSourceSummary = (
  source: MediaSourceReference | undefined,
): MediaRequestSourceSummary | undefined => {
  if (!source) {
    return undefined;
  }
  if (typeof source === "string") {
    if (/^data:/i.test(source.trim())) {
      const mimeType = source.trim().match(/^data:([^;,\s]+);base64,/i)?.[1];
      return {
        kind: "data_uri",
        ...(mimeType ? { mimeType } : {}),
      };
    }
    return { kind: "url", url: source.trim() };
  }
  return {
    kind: "base64_object",
    ...(source.mimeType.trim() ? { mimeType: source.mimeType.trim() } : {}),
  };
};

export const summarizeMediaRequestForStorage = (
  request: MediaGenerateRequest,
): StoredMediaRequestSummary => {
  const source =
    toSourceSummary(request.source) ??
    (request.sourceUrl ? { kind: "url" as const, url: request.sourceUrl } : undefined);
  const sources = request.sources
    ? Object.fromEntries(
        Object.entries(request.sources)
          .map(([key, value]) => [key, toSourceSummary(value)])
          .filter(
            (entry): entry is [string, MediaRequestSourceSummary] =>
              entry[1] !== undefined,
          ),
      )
    : undefined;

  const sanitizedInput = sanitizeJsonValue(request.input);
  return {
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(source ? { source } : {}),
    ...(sources && Object.keys(sources).length > 0 ? { sources } : {}),
    ...(isRecord(sanitizedInput) && Object.keys(sanitizedInput).length > 0
      ? { input: sanitizedInput as Record<string, Value> }
      : {}),
  };
};

const toStoredMediaJobResponse = (job: {
  jobId: string;
  capability: string;
  profile: string;
  request: StoredMediaRequestSummary;
  status: MediaJobStatus;
  upstreamStatus: string;
  queuePosition: number | null;
  logs?: Value[];
  output?: Value;
  error?: { message: string; code?: string; details?: Value };
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}) => ({
  jobId: job.jobId,
  capability: job.capability,
  profile: job.profile,
  request: job.request,
  status: job.status,
  upstreamStatus: job.upstreamStatus,
  queuePosition: job.queuePosition,
  ...(job.logs ? { logs: job.logs } : {}),
  ...(job.output !== undefined ? { output: job.output } : {}),
  ...(job.error ? { error: job.error } : {}),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
  ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
});

const toViewerOwnerId = async (ctx: QueryCtx): Promise<string> => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject) {
    return identity.subject;
  }
  if (isMediaPublicTestModeEnabled()) {
    return PUBLIC_MEDIA_TEST_OWNER_ID;
  }
  throw new ConvexError({
    code: "UNAUTHENTICATED",
    message: "Authentication required",
  });
};

const toInitialMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "IN_PROGRESS":
    case "RUNNING":
      return "running";
    default:
      return "queued";
  }
};

const toWebhookMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "OK":
    case "COMPLETED":
      return "succeeded";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "FAILED":
    case "ERROR":
    default:
      return "failed";
  }
};

const getJobByJobId = async (
  ctx: Pick<QueryCtx, "db">,
  jobId: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .unique();

const getJobByProviderRequestId = async (
  ctx: Pick<QueryCtx, "db">,
  providerRequestId: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_provider_and_providerRequestId", (q) =>
      q.eq("provider", "fal").eq("providerRequestId", providerRequestId),
    )
    .unique();

export const getByJobId = query({
  args: {
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerId(ctx);
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", ownerId).eq("jobId", args.jobId),
      )
      .unique();

    if (!job) {
      return null;
    }

    return toStoredMediaJobResponse(job);
  },
});

export const getWebhookJob = internalQuery({
  args: {
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    return {
      ownerId: job.ownerId,
      request: job.request,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
      providerResponseUrl: job.providerResponseUrl,
      providerStatusUrl: job.providerStatusUrl,
    };
  },
});

export const createJob = internalMutation({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.literal("fal"),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    billing: v.optional(mediaJobBillingValidator),
  },
  handler: async (ctx, args) => {
    const existing = await getJobByJobId(ctx, args.jobId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Media job already exists.",
      });
    }

    const now = Date.now();
    await ctx.db.insert("media_jobs", {
      ownerId: args.ownerId,
      jobId: args.jobId,
      capability: args.capability,
      profile: args.profile,
      provider: args.provider,
      endpointId: args.endpointId,
      request: args.request,
      ...(args.billing ? { billing: args.billing } : {}),
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const getFalJobForWebhook = internalQuery({
  args: {
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);
    if (!job) {
      return null;
    }
    return {
      jobId: job.jobId,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
    };
  },
});

export const markSubmitted = internalMutation({
  args: {
    jobId: v.string(),
    providerRequestId: v.string(),
    providerGatewayRequestId: v.optional(v.string()),
    providerResponseUrl: v.optional(v.string()),
    providerStatusUrl: v.optional(v.string()),
    upstreamStatus: v.string(),
    queuePosition: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Media job not found.",
      });
    }

    const now = Date.now();
    const status = toInitialMediaJobStatus(args.upstreamStatus);
    await ctx.db.patch(job._id, {
      providerRequestId: args.providerRequestId,
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(args.providerResponseUrl ? { providerResponseUrl: args.providerResponseUrl } : {}),
      ...(args.providerStatusUrl ? { providerStatusUrl: args.providerStatusUrl } : {}),
      upstreamStatus: args.upstreamStatus,
      status,
      queuePosition:
        args.queuePosition !== undefined ? args.queuePosition : job.queuePosition,
      updatedAt: now,
      ...(status === "running" && job.startedAt === undefined
        ? { startedAt: now }
        : {}),
      ...(status === "succeeded" || status === "failed" || status === "canceled"
        ? { completedAt: now }
        : {}),
    });
    return null;
  },
});

export const markSubmissionFailed = internalMutation({
  args: {
    jobId: v.string(),
    upstreamStatus: v.string(),
    error: mediaJobErrorValidator,
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "failed",
      upstreamStatus: args.upstreamStatus,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    return null;
  },
});

export const applyFalWebhook = internalMutation({
  args: {
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerGatewayRequestId: v.optional(v.string()),
    upstreamStatus: v.string(),
    output: optionalJsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
    error: v.optional(mediaJobErrorValidator),
    logs: v.optional(v.array(jsonValueValidator)),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);

    if (!job) {
      return { updated: false };
    }

    await ctx.db.patch(job._id, {
      status: toWebhookMediaJobStatus(args.upstreamStatus),
      upstreamStatus: args.upstreamStatus,
      queuePosition: null,
      ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(args.logs ? { logs: sanitizeJsonValue(args.logs) as Value[] } : {}),
      ...(args.output !== undefined
        ? { output: sanitizeJsonValue(args.output) }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      ...(args.error
        ? {
            error: {
              message: args.error.message,
              ...(args.error.code ? { code: args.error.code } : {}),
              ...(args.error.details
                ? {
                    details: sanitizeJsonValue(args.error.details),
                  }
                : {}),
            },
          }
        : {}),
      updatedAt: args.receivedAt,
      completedAt: args.receivedAt,
      lastWebhookAt: args.receivedAt,
    });

    return { updated: true, jobId: job.jobId };
  },
});


