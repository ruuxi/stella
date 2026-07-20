import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ToolContext, ToolHandlerExtras } from "./types.js";
import {
  attachImageOperationJob,
  reserveDurableImageOperation,
  settleImageOperation,
} from "./image-operation-store.js";
import {
  materializeMediaArtifact,
  readyMediaArtifactSize,
} from "./media-artifact-store.js";
import { detectSupportedImageMimeType } from "./image-reference-policy.js";

// fal permits inference to run for up to one hour and may continue retrying a
// webhook for two hours. Keep the terminal waiter beyond both envelopes.
export const MANAGED_IMAGE_JOB_TIMEOUT_MS = 3 * 60 * 60_000 + 15 * 60_000;
export const MANAGED_IMAGE_ARTIFACT_GRACE_MS = 60_000;
const INITIAL_POLL_MS = 750;
const MAX_POLL_MS = 5_000;
const SUBMIT_ATTEMPTS = 3;

type MediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";

type MediaJobError = {
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type ManagedMediaJob = {
  jobId: string;
  capability: string;
  profile: string;
  request?: { prompt?: string; aspectRatio?: string; input?: unknown };
  status: MediaJobStatus;
  upstreamStatus?: string;
  output?: unknown;
  error?: MediaJobError;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
};

export type ManagedImageArtifact = {
  kind: "image";
  index: number;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type ManagedImageTerminalResult =
  | {
      ok: true;
      job: ManagedMediaJob;
      filePaths: string[];
      artifacts: ManagedImageArtifact[];
      reattached: boolean;
    }
  | {
      ok: false;
      jobId?: string;
      status: "failed" | "canceled" | "unknown";
      code: string;
      message: string;
      reason?: unknown;
      reattached: boolean;
    };

type AcceptedJob = {
  jobId?: unknown;
  status?: unknown;
  reattached?: unknown;
};

export type ManagedImageJobOptions = {
  baseUrl: string;
  authToken: string;
  requestBody: Record<string, unknown>;
  context: ToolContext;
  extras?: ToolHandlerExtras;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  initialPollMs?: number;
  maxPollMs?: number;
  artifactGraceMs?: number;
  artifactDownloadTimeoutMs?: number;
};

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Image generation was canceled.",
  );
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const requestHeaders = (
  options: Pick<ManagedImageJobOptions, "authToken" | "context">,
  idempotencyKey: string,
  requestHash: string,
): Record<string, string> => ({
  Authorization: `Bearer ${options.authToken}`,
  "X-Device-ID": options.context.deviceId,
  "Idempotency-Key": idempotencyKey,
  "X-Stella-Request-Hash": requestHash,
});

export const hashManagedImageRequestBody = (
  requestBody: Record<string, unknown>,
): string =>
  createHash("sha256").update(JSON.stringify(requestBody)).digest("hex");

/**
 * Stable across worker/Electron restarts and external-engine continuation.
 * The durable operation ledger supplies `operationId`; run and process-local
 * tool-call ids intentionally do not participate.
 */
export const createManagedImageIdempotencyKey = (
  context: ToolContext,
  operationId = context.requestId,
): string => {
  const digest = createHash("sha256")
    .update("stella-image-gen-v1\0")
    .update(context.conversationId)
    .update("\0")
    .update(operationId)
    .digest("hex");
  return `stella-image-gen-v1-${digest}`;
};

const parseErrorResponse = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  if (!text) return `request failed with status ${response.status}`;
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
      action?: unknown;
    };
    const message =
      asNonEmptyString(parsed.error) ?? asNonEmptyString(parsed.message);
    const action = asNonEmptyString(parsed.action);
    if (message && action) return `${message} ${action}`;
    return message ?? action ?? text.trim();
  } catch {
    return text.trim();
  }
};

const parseJobStatus = (value: unknown): MediaJobStatus | null => {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "canceled":
    case "unknown":
      return value;
    default:
      return null;
  }
};

const isManagedMediaJob = (value: unknown): value is ManagedMediaJob => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    asNonEmptyString(record.jobId) &&
      asNonEmptyString(record.capability) &&
      asNonEmptyString(record.profile) &&
      parseJobStatus(record.status),
  );
};

type RemoteImage = { url: string; mimeType?: string };

const extractRemoteImages = (output: unknown): RemoteImage[] => {
  if (!output || typeof output !== "object") return [];
  const images = (output as Record<string, unknown>).images;
  if (!Array.isArray(images)) return [];
  return images
    .map((entry) => {
      if (typeof entry === "string") return { url: entry };
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const url = asNonEmptyString(record.url);
      if (!url) return null;
      const mimeType =
        asNonEmptyString(record.mimeType) ??
        asNonEmptyString(record.content_type) ??
        undefined;
      return { url, ...(mimeType ? { mimeType } : {}) };
    })
    .filter((entry): entry is RemoteImage => entry !== null);
};

const extensionFor = (url: string): string => {
  const fromUrl = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1];
  if (fromUrl && /^(?:png|jpe?g|webp|gif)$/i.test(fromUrl)) {
    return fromUrl.toLowerCase() === "jpeg" ? "jpg" : fromUrl.toLowerCase();
  }
  // Match the renderer's long-standing media-store filename contract. It
  // only sees the output URL and falls back to .png, so using response MIME
  // here would create a second jobId path when the sidebar materializes.
  return "png";
};

const existingArtifact = async (
  filePath: string,
  index: number,
  mimeType: string,
): Promise<ManagedImageArtifact | null> => {
  const sizeBytes = await readyMediaArtifactSize(filePath);
  if (sizeBytes === null) return null;
  const bytes = await fs.readFile(filePath).catch(() => null);
  const detected = bytes ? detectSupportedImageMimeType(bytes) : null;
  return detected
    ? { kind: "image", index, path: filePath, mimeType: detected, sizeBytes }
    : null;
};

const materializeImages = async (args: {
  jobId: string;
  images: RemoteImage[];
  stellaDataDir: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  downloadTimeoutMs: number;
}): Promise<{ filePaths: string[]; artifacts: ManagedImageArtifact[] }> => {
  const outputDir = path.join(args.stellaDataDir, "media", "outputs");
  await fs.mkdir(outputDir, { recursive: true });
  const artifacts: ManagedImageArtifact[] = [];

  for (const [index, image] of args.images.entries()) {
    throwIfAborted(args.signal);
    const declaredMimeType = image.mimeType ?? "image/png";
    const extension = extensionFor(image.url);
    const filePath = path.join(
      outputDir,
      `${args.jobId}_${index}.${extension}`,
    );
    const existing = await existingArtifact(filePath, index, declaredMimeType);
    if (existing) {
      artifacts.push(existing);
      continue;
    }
    let mimeType = declaredMimeType;
    const saved = await materializeMediaArtifact({
      filePath,
      signal: args.signal,
      producerTimeoutMs: args.downloadTimeoutMs,
      validateExisting: async (candidate) => {
        const bytes = await fs.readFile(candidate).catch(() => null);
        return Boolean(bytes && detectSupportedImageMimeType(bytes));
      },
      producer: async (downloadSignal) => {
        const response = await args.fetchImpl(image.url, {
          signal: downloadSignal,
          redirect: "follow",
        });
        if (!response.ok) {
          throw new Error(
            `Image artifact download failed (${response.status}).`,
          );
        }
        mimeType =
          response.headers.get("content-type")?.split(";")[0]?.trim() ||
          declaredMimeType;
        const bytes = Buffer.from(await response.arrayBuffer());
        const detected = detectSupportedImageMimeType(bytes);
        if (!detected) {
          throw new Error(
            "Image artifact was partial or had an unsupported MIME type.",
          );
        }
        mimeType = detected;
        return bytes;
      },
    });
    artifacts.push({
      kind: "image",
      index,
      path: saved.path,
      mimeType,
      sizeBytes: saved.sizeBytes,
    });
  }

  return {
    filePaths: artifacts.map((artifact) => artifact.path),
    artifacts,
  };
};

const cancelRequest = async (args: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  headers: Record<string, string>;
}): Promise<boolean> => {
  // Cancellation uses an independent signal because the tool's signal is
  // already aborted. Repeating DELETE is safe: the gateway persists one
  // owner-scoped tombstone before attempting provider cancellation.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await args.fetchImpl(
        new URL("/api/media/v1/job", args.baseUrl),
        {
          method: "DELETE",
          headers: args.headers,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) return true;
    } catch {
      // A relay may be reconnecting; retry only the idempotent cancellation,
      // never the generation itself.
    }
  }
  return false;
};

const statusText = (job: ManagedMediaJob): string =>
  job.status === "queued"
    ? "Image generation is queued…"
    : job.status === "running"
      ? "Generating image…"
      : job.status === "succeeded"
        ? "Saving generated image…"
        : job.status === "unknown"
          ? "Image outcome could not be reconciled."
          : "Image generation finished.";

export const submitAndWaitForManagedImageJob = async (
  options: ManagedImageJobOptions,
): Promise<ManagedImageTerminalResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const timeoutMs = options.timeoutMs ?? MANAGED_IMAGE_JOB_TIMEOUT_MS;
  const artifactGraceMs =
    options.artifactGraceMs ?? MANAGED_IMAGE_ARTIFACT_GRACE_MS;
  const artifactDownloadTimeoutMs = options.artifactDownloadTimeoutMs ?? 30_000;
  const initialPollMs = options.initialPollMs ?? INITIAL_POLL_MS;
  const maxPollMs = options.maxPollMs ?? MAX_POLL_MS;
  const signal = options.extras?.signal;
  const stellaDataDir =
    options.context.stellaDataDir ??
    options.context.stellaAppDir ??
    process.cwd();
  const operation = reserveDurableImageOperation({
    stellaDataDir,
    conversationId: options.context.conversationId,
    toolCallId: options.context.requestId,
    requestBody: options.requestBody,
  });
  if (operation.terminalResult) return operation.terminalResult;
  const finish = (
    result: ManagedImageTerminalResult,
  ): ManagedImageTerminalResult => {
    settleImageOperation({
      stellaDataDir,
      operationId: operation.operationId,
      result,
    });
    return result;
  };
  const idempotencyKey = createManagedImageIdempotencyKey(
    options.context,
    operation.operationId,
  );
  const requestHash = hashManagedImageRequestBody(options.requestBody);
  const headers = requestHeaders(options, idempotencyKey, requestHash);
  const deadline = now() + timeoutMs;
  let accepted: AcceptedJob | null = operation.jobId
    ? { jobId: operation.jobId, reattached: true }
    : null;
  let lastSubmitError = "";

  const reconcileAcceptance = async (): Promise<AcceptedJob | null> => {
    try {
      const url = new URL("/api/media/v1/job", options.baseUrl);
      url.searchParams.set("clientRequestKey", idempotencyKey);
      url.searchParams.set("requestHash", requestHash);
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        lastSubmitError = await parseErrorResponse(response);
        return null;
      }
      return {
        ...((await response.json()) as AcceptedJob),
        reattached: true,
      };
    } catch (error) {
      throwIfAborted(signal);
      lastSubmitError = (error as Error).message;
      return null;
    }
  };

  try {
    for (
      let attempt = 0;
      !accepted && attempt < SUBMIT_ATTEMPTS;
      attempt += 1
    ) {
      throwIfAborted(signal);
      try {
        const response = await fetchImpl(
          new URL("/api/media/v1/generate", options.baseUrl),
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(options.requestBody),
            signal,
          },
        );
        if (response.ok) {
          accepted = (await response.json()) as AcceptedJob;
          break;
        }
        lastSubmitError = await parseErrorResponse(response);
        if (response.status < 500) {
          return finish({
            ok: false,
            status: "failed",
            code: `submission_${response.status}`,
            message: lastSubmitError,
            reattached: operation.reattached,
          });
        }
      } catch (error) {
        throwIfAborted(signal);
        lastSubmitError = (error as Error).message;
      }
      accepted = await reconcileAcceptance();
      if (accepted) break;
      await sleep(Math.min(250 * 2 ** attempt, 1_000), signal);
    }

    let reconciliationPollMs = initialPollMs;
    while (!accepted && now() < deadline) {
      options.extras?.onUpdate?.({
        details: {
          status: "queued",
          statusText: "Reattaching durable image submission…",
        },
      });
      accepted = await reconcileAcceptance();
      if (accepted) break;
      await sleep(
        Math.min(reconciliationPollMs, Math.max(1, deadline - now())),
        signal,
      );
      reconciliationPollMs = Math.min(
        maxPollMs,
        Math.max(initialPollMs, reconciliationPollMs * 1.5),
      );
    }
    const jobId = asNonEmptyString(accepted?.jobId);
    if (!jobId) {
      return finish({
        ok: false,
        status: "unknown",
        code: "submission_outcome_unknown",
        message:
          "Stella could not confirm whether the image request was accepted. It will not submit a duplicate.",
        ...(lastSubmitError ? { reason: { cause: lastSubmitError } } : {}),
        reattached: operation.reattached,
      });
    }
    attachImageOperationJob({
      stellaDataDir,
      operationId: operation.operationId,
      jobId,
    });
    const reattached = operation.reattached || accepted?.reattached === true;
    let pollMs = initialPollMs;
    let artifactDeadline: number | null = null;
    let lastJob: ManagedMediaJob | null = null;

    while (now() < deadline) {
      throwIfAborted(signal);
      try {
        const url = new URL("/api/media/v1/job", options.baseUrl);
        url.searchParams.set("jobId", jobId);
        const response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal,
        });
        if (!response.ok) {
          if (response.status < 500) {
            return finish({
              ok: false,
              jobId,
              status: "failed",
              code: `job_lookup_${response.status}`,
              message: await parseErrorResponse(response),
              reattached,
            });
          }
        } else {
          const value = (await response.json()) as unknown;
          if (!isManagedMediaJob(value)) {
            return finish({
              ok: false,
              jobId,
              status: "failed",
              code: "invalid_job_response",
              message: "Image generation returned an invalid job response.",
              reattached,
            });
          }
          lastJob = value;
          options.extras?.onUpdate?.({
            details: {
              jobId,
              status: value.status,
              statusText: statusText(value),
            },
          });

          if (
            value.status === "failed" ||
            value.status === "canceled" ||
            value.status === "unknown"
          ) {
            return finish({
              ok: false,
              jobId,
              status: value.status,
              code:
                asNonEmptyString(value.error?.code)?.toLowerCase() ??
                value.status,
              message:
                asNonEmptyString(value.error?.message) ??
                `Image generation ${value.status}.`,
              ...(value.error?.details ? { reason: value.error.details } : {}),
              reattached,
            });
          }

          if (value.status === "succeeded") {
            artifactDeadline ??= Math.min(deadline, now() + artifactGraceMs);
            const images = extractRemoteImages(value.output);
            if (images.length > 0) {
              try {
                const materialized = await materializeImages({
                  jobId,
                  images,
                  stellaDataDir,
                  fetchImpl,
                  signal,
                  downloadTimeoutMs: Math.max(
                    1,
                    Math.min(
                      artifactDownloadTimeoutMs,
                      artifactDeadline - now(),
                    ),
                  ),
                });
                return finish({
                  ok: true,
                  job: value,
                  ...materialized,
                  reattached,
                });
              } catch (error) {
                throwIfAborted(signal);
                if (now() >= artifactDeadline) {
                  return finish({
                    ok: false,
                    jobId,
                    status: "failed",
                    code: "artifact_materialization_failed",
                    message: `Image completed but its artifact could not be saved: ${(error as Error).message}`,
                    reattached,
                  });
                }
              }
            } else {
              if (now() >= artifactDeadline) {
                return finish({
                  ok: false,
                  jobId,
                  status: "failed",
                  code: "artifact_missing",
                  message:
                    "Image generation completed without a downloadable artifact.",
                  reattached,
                });
              }
            }
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        // Transient lookup/JSON/network failures reattach on the next poll.
      }

      await sleep(Math.min(pollMs, Math.max(1, deadline - now())), signal);
      pollMs = Math.min(maxPollMs, Math.max(initialPollMs, pollMs * 1.5));
    }

    const timeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
    return finish({
      ok: false,
      jobId: asNonEmptyString(accepted?.jobId) ?? undefined,
      status: "unknown",
      code: "terminal_outcome_unknown",
      message: `Image generation still had no durable terminal outcome after ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}. Stella did not cancel or resubmit it.`,
      ...(lastJob?.error ? { reason: lastJob.error } : {}),
      reattached: accepted?.reattached === true,
    });
  } catch (error) {
    if (signal?.aborted) {
      await cancelRequest({ fetchImpl, baseUrl: options.baseUrl, headers });
      settleImageOperation({
        stellaDataDir,
        operationId: operation.operationId,
        result: {
          ok: false,
          ...(asNonEmptyString(accepted?.jobId)
            ? { jobId: asNonEmptyString(accepted?.jobId)! }
            : {}),
          status: "canceled",
          code: "canceled",
          message: "Image generation was canceled.",
          reattached: operation.reattached || accepted?.reattached === true,
        },
      });
      throw abortError(signal);
    }
    throw error;
  }
};
