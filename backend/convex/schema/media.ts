import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  MEDIA_BILLING_UNITS,
  MEDIA_METERED_FROM_VALUES,
  jsonObjectValidator,
  jsonValueValidator,
  optionalJsonValueValidator,
} from "../shared_validators";

export const mediaJobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const mediaJobErrorValidator = v.object({
  message: v.string(),
  code: v.optional(v.string()),
  details: optionalJsonValueValidator,
});

export const mediaRequestSourceSummaryValidator = v.object({
  kind: v.union(
    v.literal("url"),
    v.literal("data_uri"),
    v.literal("base64_object"),
  ),
  mimeType: v.optional(v.string()),
  url: v.optional(v.string()),
});

export const mediaRequestSummaryValidator = v.object({
  prompt: v.optional(v.string()),
  aspectRatio: v.optional(v.string()),
  source: v.optional(mediaRequestSourceSummaryValidator),
  sources: v.optional(v.record(v.string(), mediaRequestSourceSummaryValidator)),
  input: v.optional(jsonObjectValidator),
});

export const mediaJobSubscriptionValidator = v.object({
  query: v.string(),
  args: jsonObjectValidator,
});

const billingUnitValidator = v.union(
  ...(MEDIA_BILLING_UNITS.map((u) => v.literal(u)) as [
    ReturnType<typeof v.literal>,
    ReturnType<typeof v.literal>,
    ...ReturnType<typeof v.literal>[],
  ]),
);

const meteredFromValidator = v.union(
  ...(MEDIA_METERED_FROM_VALUES.map((u) => v.literal(u)) as [
    ReturnType<typeof v.literal>,
    ReturnType<typeof v.literal>,
    ...ReturnType<typeof v.literal>[],
  ]),
);

export const mediaJobBillingValidator = v.object({
  endpointId: v.string(),
  billingUnit: billingUnitValidator,
  unitPriceUsd: v.number(),
  quantity: v.number(),
  costMicroCents: v.number(),
  meteredFrom: meteredFromValidator,
  note: v.optional(v.string()),
});

export const mediaJobResponseValidator = v.object({
  jobId: v.string(),
  capability: v.string(),
  profile: v.string(),
  request: mediaRequestSummaryValidator,
  status: mediaJobStatusValidator,
  upstreamStatus: v.string(),
  queuePosition: v.union(v.number(), v.null()),
  logs: v.optional(v.array(jsonValueValidator)),
  output: optionalJsonValueValidator,
  error: v.optional(mediaJobErrorValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

export const mediaSchema = {
  media_jobs: defineTable({
    ownerId: v.string(),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(v.literal("fal"), v.literal("google_lyria")),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    billing: v.optional(mediaJobBillingValidator),
    providerRequestId: v.optional(v.string()),
    providerGatewayRequestId: v.optional(v.string()),
    providerResponseUrl: v.optional(v.string()),
    providerStatusUrl: v.optional(v.string()),
    status: mediaJobStatusValidator,
    upstreamStatus: v.string(),
    queuePosition: v.union(v.number(), v.null()),
    output: optionalJsonValueValidator,
    error: v.optional(mediaJobErrorValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    // The desktop materializer subscribes via `listSucceededSince`, which
    // wants succeeded jobs in completion order. Adding `(status, completedAt)`
    // as a compound index lets that query return only succeeded rows
    // directly, rather than over-fetching `(ownerId, createdAt)` and JS
    // filtering by `status === "succeeded"`.
    .index("by_ownerId_and_status_and_completedAt", [
      "ownerId",
      "status",
      "completedAt",
    ])
    .index("by_provider_and_providerRequestId", [
      "provider",
      "providerRequestId",
    ]),

  /**
   * Per-job webhook log entries split out from `media_jobs.logs`. Each fal
   * webhook delivery appends one row per log entry, so a long-running media
   * generation can accumulate many entries without rewriting the job
   * document or hitting the 1MB document size limit.
   */
  media_job_logs: defineTable({
    ownerId: v.string(),
    jobId: v.string(),
    ordinal: v.number(),
    receivedAt: v.number(),
    entry: jsonValueValidator,
  })
    .index("by_jobId_and_ordinal", ["jobId", "ordinal"])
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"]),
};
