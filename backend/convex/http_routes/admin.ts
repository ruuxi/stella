import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAdminRequest } from "../http_shared/admin";

const ADMIN_DELETE_PATH = "/api/admin/delete";
const SOCIAL_DELETE_MAX_STEPS = 200;

type AdminDeleteBody = {
  kind?: string;
  id?: string;
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

export const registerAdminRoutes = (http: HttpRouter) => {
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
