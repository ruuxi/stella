import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAdminRequest } from "../http_shared/admin";

const ADMIN_DELETE_PATH = "/api/admin/delete";
const ADMIN_BILLING_PLAN_PATH = "/api/admin/billing/plan";
const SOCIAL_DELETE_MAX_STEPS = 200;

type AdminDeleteBody = {
  kind?: string;
  id?: string;
};

type AdminBillingPlanBody = {
  ownerId?: string;
  plan?: string;
  unlimited?: boolean;
  usageMode?: string;
  subscriptionStatus?: string;
  resetUsage?: boolean;
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const parseRequestJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const readDeleteBody = async (
  request: Request,
): Promise<{ kind: string; id: string } | Response> => {
  const body = (await parseRequestJson(request)) as AdminDeleteBody | null;
  const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!kind || !id) {
    return jsonResponse(400, { error: "Missing kind or id." });
  }
  return { kind, id };
};

const isBillingPlan = (
  value: string,
): value is "free" | "go" | "pro" | "plus" | "ultra" =>
  value === "free" ||
  value === "go" ||
  value === "pro" ||
  value === "plus" ||
  value === "ultra";

const readBillingPlanBody = async (
  request: Request,
): Promise<{
  ownerId: string;
  plan?: "free" | "go" | "pro" | "plus" | "ultra";
  usageMode?: "default" | "unlimited";
  subscriptionStatus?: string;
  resetUsage?: boolean;
} | Response> => {
  const body = (await parseRequestJson(request)) as AdminBillingPlanBody | null;
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
  if (!ownerId) {
    return jsonResponse(400, { error: "Missing ownerId." });
  }

  const rawPlan = typeof body?.plan === "string" ? body.plan.trim().toLowerCase() : "";
  let plan: "free" | "go" | "pro" | "plus" | "ultra" | undefined;
  if (rawPlan && isBillingPlan(rawPlan)) {
    plan = rawPlan;
  } else if (rawPlan) {
    return jsonResponse(400, { error: `Unsupported plan: ${rawPlan}` });
  }

  const rawUsageMode =
    typeof body?.usageMode === "string" ? body.usageMode.trim().toLowerCase() : "";
  let usageMode: "default" | "unlimited" | undefined;
  if (typeof body?.unlimited === "boolean") {
    usageMode = body.unlimited ? "unlimited" : "default";
  } else if (rawUsageMode === "default" || rawUsageMode === "unlimited") {
    usageMode = rawUsageMode;
  } else if (rawUsageMode) {
    return jsonResponse(400, { error: `Unsupported usageMode: ${rawUsageMode}` });
  }

  const subscriptionStatus =
    typeof body?.subscriptionStatus === "string"
      ? body.subscriptionStatus.trim()
      : undefined;
  const resetUsage =
    typeof body?.resetUsage === "boolean" ? body.resetUsage : undefined;

  return {
    ownerId,
    ...(plan ? { plan } : {}),
    ...(usageMode ? { usageMode } : {}),
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    ...(resetUsage !== undefined ? { resetUsage } : {}),
  };
};

export const registerAdminRoutes = (http: HttpRouter) => {
  http.route({
    path: ADMIN_BILLING_PLAN_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;

      const parsed = await readBillingPlanBody(request);
      if (parsed instanceof Response) return parsed;

      return jsonResponse(
        200,
        await ctx.runMutation(internal.billing.setAdminBillingPlan, parsed),
      );
    }),
  });

  http.route({
    path: ADMIN_DELETE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;

      const parsed = await readDeleteBody(request);
      if (parsed instanceof Response) return parsed;

      const { kind, id } = parsed;
      switch (kind) {
        case "catalog_pet":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.data.pets.deleteByPetId, { id }),
          );
        case "store_package":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteStorePackage, {
              packageId: id,
            }),
          );
        case "user_pet":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteUserPet, {
              petId: id,
            }),
          );
        case "emoji_pack":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteEmojiPack, {
              packId: id,
            }),
          );
        case "media_job": {
          let result: { hasMore?: boolean } | null = null;
          for (let step = 0; step < SOCIAL_DELETE_MAX_STEPS; step += 1) {
            result = await ctx.runMutation(
              internal.admin_deletes.deleteMediaJob,
              { jobId: id },
            );
            if (!result.hasMore) return jsonResponse(200, result);
          }
          return jsonResponse(409, {
            error: "Media job delete needs another request.",
            kind,
            id,
            hasMore: true,
          });
        }
        case "feedback":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteFeedback, { id }),
          );
        case "desktop_release":
          return jsonResponse(
            200,
            await ctx.runMutation(
              internal.admin_deletes.deleteDesktopRelease,
              { platform: id },
            ),
          );
        case "social_message":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteSocialMessage, {
              id,
            }),
          );
        case "stella_session": {
          let result: { hasMore?: boolean } | null = null;
          for (let step = 0; step < SOCIAL_DELETE_MAX_STEPS; step += 1) {
            result = await ctx.runMutation(
              internal.admin_deletes.deleteStellaSessionBatch,
              { id },
            );
            if (!result.hasMore) return jsonResponse(200, result);
          }
          return jsonResponse(409, {
            error: "Session delete needs another request.",
            kind,
            id,
            hasMore: true,
          });
        }
        case "social_room": {
          let result: { hasMore?: boolean; label?: string } | null = null;
          for (let step = 0; step < SOCIAL_DELETE_MAX_STEPS; step += 1) {
            result = await ctx.runMutation(
              internal.admin_deletes.deleteSocialRoomBatch,
              { id },
            );
            if (result.hasMore && result.label) {
              await ctx.runMutation(
                internal.admin_deletes.deleteStellaSessionBatch,
                { id: result.label },
              );
              continue;
            }
            if (!result.hasMore) return jsonResponse(200, result);
          }
          return jsonResponse(409, {
            error: "Social room delete needs another request.",
            kind,
            id,
            hasMore: true,
          });
        }
        default:
          return jsonResponse(400, { error: `Unsupported delete kind: ${kind}` });
      }
    }),
  });
};
