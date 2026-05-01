import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const DESKTOP_RELEASE_PUBLISH_PATH = "/api/desktop-releases/publish";

/**
 * Shared CI secret. Set in Convex deployment env via
 * `bunx convex env set DESKTOP_RELEASE_PUBLISH_SECRET <random>`. The CI
 * workflow passes the same value as `Authorization: Bearer <secret>`
 * after uploading the desktop tarball + R2 manifest.
 */
const getPublishSecret = () =>
  process.env.DESKTOP_RELEASE_PUBLISH_SECRET?.trim() ?? "";

type PublishRequestBody = {
  tag?: string;
  commit?: string;
  publishedAt?: number | string;
  assets?: Record<
    string,
    {
      url?: string;
      sha256?: string;
      size?: number;
    }
  >;
};

const parseRequestJson = async (
  request: Request,
): Promise<PublishRequestBody | null> => {
  try {
    return (await request.json()) as PublishRequestBody;
  } catch {
    return null;
  }
};

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const normalizePublishedAt = (
  value: PublishRequestBody["publishedAt"],
): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

export const registerDesktopReleaseRoutes = (http: HttpRouter) => {
  http.route({
    path: DESKTOP_RELEASE_PUBLISH_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const expected = getPublishSecret();
      if (!expected) {
        return errorResponse(503, "Desktop release publish endpoint disabled.");
      }
      const auth = request.headers.get("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (provided !== expected) {
        return errorResponse(401, "Invalid publish credentials.");
      }
      const body = await parseRequestJson(request);
      if (!body || typeof body.tag !== "string" || typeof body.commit !== "string") {
        return errorResponse(400, "Missing tag/commit in request body.");
      }
      const publishedAt = normalizePublishedAt(body.publishedAt) ?? Date.now();
      const assets = body.assets ?? {};
      const platforms = Object.keys(assets);
      if (platforms.length === 0) {
        return errorResponse(400, "Missing assets map.");
      }
      const written: string[] = [];
      for (const platform of platforms) {
        const asset = assets[platform];
        if (
          !asset
          || typeof asset.url !== "string"
          || typeof asset.sha256 !== "string"
          || typeof asset.size !== "number"
        ) {
          return errorResponse(
            400,
            `Asset entry for ${platform} is missing url/sha256/size.`,
          );
        }
        await ctx.runMutation(
          internal.data.desktop_releases.publishDesktopRelease,
          {
            platform,
            tag: body.tag,
            commit: body.commit,
            archiveUrl: asset.url,
            archiveSha256: asset.sha256,
            archiveSize: asset.size,
            publishedAt,
          },
        );
        written.push(platform);
      }
      return new Response(
        JSON.stringify({ tag: body.tag, commit: body.commit, written }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }),
  });
};
