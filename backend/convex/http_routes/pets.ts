import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireAdminRequest } from "../http_shared/admin";

const PET_CATALOG_SEED_PATH = "/api/pets/seed";
const ADMIN_PET_CATALOG_DELETE_PATH = "/api/admin/pets/delete";

const getSeedSecret = () => process.env.PET_CATALOG_SEED_SECRET?.trim() ?? "";

type PetSeedRequestBody = {
  pets?: Array<{
    id?: string;
    displayName?: string;
    description?: string;
    kind?: string;
    tags?: string[];
    ownerName?: string | null;
    spritesheetUrl?: string;
    sourceUrl?: string;
    previewUrl?: string;
    published?: boolean;
    sortOrder?: number;
    updatedAt?: number;
    downloads?: number;
  }>;
};

type PetDeleteRequestBody = {
  id?: string;
};

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const parseRequestJson = async (
  request: Request,
): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const normalizePet = (
  pet: NonNullable<PetSeedRequestBody["pets"]>[number],
  index: number,
  updatedAt: number,
) => {
  if (
    typeof pet.id !== "string" ||
    typeof pet.displayName !== "string" ||
    typeof pet.spritesheetUrl !== "string" ||
    pet.id.length === 0 ||
    pet.spritesheetUrl.length === 0
  ) {
    return null;
  }
  return {
    id: pet.id,
    displayName: pet.displayName,
    description: typeof pet.description === "string" ? pet.description : "",
    kind: typeof pet.kind === "string" && pet.kind.length > 0 ? pet.kind : "object",
    tags: Array.isArray(pet.tags)
      ? pet.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    ownerName: typeof pet.ownerName === "string" ? pet.ownerName : null,
    spritesheetUrl: pet.spritesheetUrl,
    sourceUrl: typeof pet.sourceUrl === "string" ? pet.sourceUrl : "",
    previewUrl: typeof pet.previewUrl === "string" ? pet.previewUrl : undefined,
    published: pet.published ?? true,
    sortOrder: Number.isFinite(pet.sortOrder) ? Number(pet.sortOrder) : index,
    updatedAt: Number.isFinite(pet.updatedAt) ? Number(pet.updatedAt) : updatedAt,
    downloads: Number.isFinite(pet.downloads) ? Number(pet.downloads) : 0,
  };
};

export const registerPetRoutes = (http: HttpRouter) => {
  http.route({
    path: PET_CATALOG_SEED_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const expected = getSeedSecret();
      if (!expected) {
        return errorResponse(503, "Pet catalog seed endpoint disabled.");
      }
      const auth = request.headers.get("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (provided !== expected) {
        return errorResponse(401, "Invalid seed credentials.");
      }

      const body = (await parseRequestJson(request)) as PetSeedRequestBody | null;
      if (!body || !Array.isArray(body.pets)) {
        return errorResponse(400, "Missing pets array.");
      }

      const updatedAt = Date.now();
      const pets = body.pets
        .map((pet, index) => normalizePet(pet, index, updatedAt))
        .filter((pet): pet is NonNullable<ReturnType<typeof normalizePet>> => pet !== null);

      if (pets.length === 0) {
        return errorResponse(400, "No valid pets to seed.");
      }

      await ctx.runMutation(internal.data.pets.upsertMany, { pets });

      return new Response(JSON.stringify({ seeded: pets.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  });

  http.route({
    path: ADMIN_PET_CATALOG_DELETE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;

      const body = (await parseRequestJson(request)) as PetDeleteRequestBody | null;
      const id =
        body && "id" in body && typeof body.id === "string"
          ? body.id.trim()
          : "";
      if (!id) {
        return errorResponse(400, "Missing pet id.");
      }

      const result = await ctx.runMutation(internal.data.pets.deleteByPetId, {
        id,
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  });
};
