import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { ConvexError } from "convex/values";
import { isAnonymousIdentity } from "../auth";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";

// Per-owner cap shared by every /api/backups/* endpoint. Backups are
// chunky (storage writes + manifest mutations + R2 plan generation), so
// even legitimate clients should not exceed a few dozen calls per
// minute. A misbehaving client gets locked out of the whole surface.
const BACKUP_RATE_LIMIT = 60;
const BACKUP_RATE_WINDOW_MS = 60_000;

const BACKUP_KEY_PATH = "/api/backups/key";
const BACKUP_LIST_PATH = "/api/backups/list";
const BACKUP_PREPARE_UPLOAD_PATH = "/api/backups/prepare-upload";
const BACKUP_FINALIZE_UPLOAD_PATH = "/api/backups/finalize-upload";
const BACKUP_RESTORE_MANIFEST_PATH = "/api/backups/restore-manifest";
const BACKUP_OBJECT_DOWNLOADS_PATH = "/api/backups/object-downloads";

const parseRouteJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const getOwnerIdFromRequest = async (
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  }
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use backups.",
    });
  }
  return identity.tokenIdentifier;
};

/**
 * Resolve the owner and consume one slot from the shared backup rate
 * limit. Returns either the owner id (allowed) or a 429 response that the
 * caller should return verbatim. Centralized here so every backup
 * endpoint shares a single per-owner budget rather than each one running
 * its own quota.
 */
const requireBackupOwner = async (
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  origin: string | null,
): Promise<{ ownerId: string } | { response: Response }> => {
  const ownerId = await getOwnerIdFromRequest(ctx);
  const rateLimit = await consumeWebhookRateLimit(ctx, {
    scope: "backups_owner",
    key: ownerId,
    limit: BACKUP_RATE_LIMIT,
    windowMs: BACKUP_RATE_WINDOW_MS,
    blockMs: BACKUP_RATE_WINDOW_MS,
  });
  if (!rateLimit.allowed) {
    return { response: withCors(rateLimitResponse(rateLimit.retryAfterMs), origin) };
  }
  return { ownerId };
};

const getRequiredDeviceId = (request: Request) => {
  const deviceId = request.headers.get("x-device-id")?.trim();
  if (!deviceId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Missing X-Device-ID header.",
    });
  }
  return deviceId;
};

const toErrorResponse = (
  error: unknown,
  origin: string | null,
): Response => {
  if (error instanceof ConvexError) {
    const data = error.data as Record<string, unknown> | undefined;
    const message =
      typeof data?.message === "string" ? data.message : "Backup request failed.";
    const code = typeof data?.code === "string" ? data.code : "";
    const status =
      code === "UNAUTHENTICATED" ? 401
        : code === "UNAUTHORIZED" ? 403
          : code === "NOT_FOUND" ? 404
            : code === "CONFLICT" ? 409
              : 400;
    return errorResponse(status, message, origin);
  }
  if (error instanceof Error) {
    return errorResponse(500, error.message || "Backup request failed.", origin);
  }
  return errorResponse(500, "Backup request failed.", origin);
};

export const registerBackupRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    BACKUP_KEY_PATH,
    BACKUP_LIST_PATH,
    BACKUP_PREPARE_UPLOAD_PATH,
    BACKUP_FINALIZE_UPLOAD_PATH,
    BACKUP_RESTORE_MANIFEST_PATH,
    BACKUP_OBJECT_DOWNLOADS_PATH,
  ]);

  http.route({
    path: BACKUP_KEY_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const deviceId = getRequiredDeviceId(request);
          await ctx.runQuery(internal.backups.assertDeviceOwnedInternal, {
            ownerId,
            deviceId,
          });
          const key = await ctx.runAction(internal.backups.getKeyEscrowStatusInternal, {
            ownerId,
          });
          return jsonResponse({ key }, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_KEY_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const sourceDeviceId = getRequiredDeviceId(request);
          const body = await parseRouteJson<{
            keyBase64Url?: string;
            keyFingerprint?: string;
          }>(request);
          if (!body?.keyBase64Url || !body.keyFingerprint) {
            return errorResponse(400, "Invalid backup key request body.", origin);
          }
          const result = await ctx.runMutation(internal.backups.ensureKeyEscrowInternal, {
            ownerId,
            sourceDeviceId,
            keyBase64Url: body.keyBase64Url,
            keyFingerprint: body.keyFingerprint,
          });
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_LIST_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const deviceId = getRequiredDeviceId(request);
          await ctx.runQuery(internal.backups.assertDeviceOwnedInternal, {
            ownerId,
            deviceId,
          });
          const url = new URL(request.url);
          const limitParam = url.searchParams.get("limit");
          const sourceDeviceId = url.searchParams.get("sourceDeviceId")?.trim() || undefined;
          const limit =
            limitParam && limitParam.trim().length > 0
              ? Number(limitParam)
              : undefined;
          const backups = await ctx.runQuery(internal.backups.listBackupsForOwnerInternal, {
            ownerId,
            sourceDeviceId,
            limit,
          });
          return jsonResponse({ backups }, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_PREPARE_UPLOAD_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const sourceDeviceId = getRequiredDeviceId(request);
          const body = await parseRouteJson<{
            snapshotId?: string;
            snapshotHash?: string;
            createdAt?: number;
            objects?: Array<{
              objectId: string;
              plaintextSha256: string;
              plaintextSize: number;
              algorithm: string;
              ivBase64Url: string;
              authTagBase64Url: string;
            }>;
          }>(request);
          if (
            !body?.snapshotId
            || !body.snapshotHash
            || typeof body.createdAt !== "number"
            || !Array.isArray(body.objects)
          ) {
            return errorResponse(400, "Invalid backup prepare-upload body.", origin);
          }
          const result = await ctx.runMutation(internal.backups.prepareUploadInternal, {
            ownerId,
            sourceDeviceId,
            snapshotId: body.snapshotId,
            snapshotHash: body.snapshotHash,
            createdAt: body.createdAt,
            objects: body.objects,
          });
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_FINALIZE_UPLOAD_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const sourceDeviceId = getRequiredDeviceId(request);
          const body = await parseRouteJson<{
            snapshotId?: string;
            snapshotHash?: string;
            createdAt?: number;
            sourceHostname?: string;
            version?: number;
            entryCount?: number;
            objectCount?: number;
            markLatest?: boolean;
            manifest?: {
              r2Key: string;
              plaintextSha256: string;
              plaintextSize: number;
              algorithm: string;
              ivBase64Url: string;
              authTagBase64Url: string;
            };
            uploadedObjects?: Array<{
              objectId: string;
              plaintextSha256: string;
              plaintextSize: number;
              algorithm: string;
              ivBase64Url: string;
              authTagBase64Url: string;
              r2Key: string;
            }>;
          }>(request);
          if (
            !body?.snapshotId
            || !body.snapshotHash
            || typeof body.createdAt !== "number"
            || typeof body.version !== "number"
            || typeof body.entryCount !== "number"
            || typeof body.objectCount !== "number"
            || !body.manifest
            || !Array.isArray(body.uploadedObjects)
          ) {
            return errorResponse(400, "Invalid backup finalize-upload body.", origin);
          }
          const result = await ctx.runMutation(internal.backups.finalizeUploadInternal, {
            ownerId,
            sourceDeviceId,
            snapshotId: body.snapshotId,
            snapshotHash: body.snapshotHash,
            createdAt: body.createdAt,
            sourceHostname: body.sourceHostname,
            version: body.version,
            entryCount: body.entryCount,
            objectCount: body.objectCount,
            markLatest: body.markLatest,
            manifest: body.manifest,
            uploadedObjects: body.uploadedObjects,
          });
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_RESTORE_MANIFEST_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const deviceId = getRequiredDeviceId(request);
          const body = await parseRouteJson<{ snapshotId?: string }>(request);
          if (!body?.snapshotId) {
            return errorResponse(400, "Missing snapshotId.", origin);
          }
          const result = await ctx.runAction(
            internal.backups.getManifestDownloadPlanInternal,
            {
              ownerId,
              deviceId,
              snapshotId: body.snapshotId,
            },
          );
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });

  http.route({
    path: BACKUP_OBJECT_DOWNLOADS_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        try {
          const owner = await requireBackupOwner(ctx, origin);
          if ("response" in owner) return owner.response;
          const ownerId = owner.ownerId;
          const deviceId = getRequiredDeviceId(request);
          const body = await parseRouteJson<{ objectIds?: string[] }>(request);
          if (!body?.objectIds || !Array.isArray(body.objectIds)) {
            return errorResponse(400, "Missing objectIds.", origin);
          }
          const result = await ctx.runAction(
            internal.backups.getObjectDownloadPlanInternal,
            {
              ownerId,
              deviceId,
              objectIds: body.objectIds,
            },
          );
          return jsonResponse({ objects: result }, 200, origin);
        } catch (error) {
          return toErrorResponse(error, origin);
        }
      })),
  });
};
