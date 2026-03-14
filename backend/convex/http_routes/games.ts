/**
 * Game hosting HTTP routes.
 *
 * Serves deployed game client assets from Convex storage and provides
 * a join redirect endpoint for shareable URLs.
 *
 * Routes:
 *   GET /games/join?code=ABCD         → Redirects to the game with session param
 *   GET /games/:gameId/               → Serves index.html (SPA entry)
 *   GET /games/:gameId/assets/...     → Serves static assets (JS, CSS, images)
 */

import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  corsPreflightHandler,
  getCorsHeaders,
  errorResponse,
} from "../http_shared/cors";

const GAMES_BASE_PATH = "/games";

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

const getContentType = (path: string): string => {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "application/octet-stream";
  const ext = path.slice(lastDot).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
};

const getCacheControl = (path: string): string => {
  // Hashed assets (Vite output) can be cached aggressively
  if (path.includes("/assets/") && /\.[a-f0-9]{8,}\.(js|css|woff2?)$/i.test(path)) {
    return "public, max-age=31536000, immutable";
  }
  // HTML and other files: short cache with revalidation
  return "public, max-age=60, stale-while-revalidate=300";
};

/**
 * Join redirect: GET /games/join?code=ABCD
 * Looks up the join code and redirects to the game URL.
 */
const joinRedirectHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.toUpperCase().trim();

  if (!code || code.length !== 4) {
    return errorResponse(400, "Invalid join code", request.headers.get("origin"));
  }

  const game = await ctx.runQuery(internal.data.games.getGameByJoinCodeInternal, {
    joinCode: code,
  });

  if (!game || game.status !== "active") {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff"><div style="text-align:center"><h1>Game Not Found</h1><p>The join code <strong>${code}</strong> doesn't match any active game.</p></div></body></html>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const params = new URLSearchParams();
  params.set("code", game.joinCode);
  if (game.spacetimeSessionId) {
    params.set("session", game.spacetimeSessionId);
  }
  const redirectUrl = `${GAMES_BASE_PATH}/${game.gameId}/?${params.toString()}`;

  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
});

/**
 * Serve a game asset from Convex storage.
 * Handles both the SPA index.html and static asset files.
 */
const serveGameAsset = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Parse: /games/:gameId/... → extract gameId and asset path
  const afterGames = pathname.slice(GAMES_BASE_PATH.length + 1); // strip "/games/"
  const slashIndex = afterGames.indexOf("/");

  const gameId = slashIndex === -1 ? afterGames : afterGames.slice(0, slashIndex);
  let assetPath = slashIndex === -1 ? "" : afterGames.slice(slashIndex + 1);

  if (!gameId) {
    return errorResponse(404, "Game not found", request.headers.get("origin"));
  }

  // SPA fallback: serve index.html for root and non-asset paths
  if (!assetPath || !assetPath.includes(".")) {
    assetPath = "index.html";
  }

  const asset = await ctx.runQuery(internal.data.games.getGameAsset, {
    gameId,
    path: assetPath,
  });

  if (!asset) {
    // SPA fallback: try index.html for client-side routing
    if (assetPath !== "index.html") {
      const indexAsset = await ctx.runQuery(internal.data.games.getGameAsset, {
        gameId,
        path: "index.html",
      });
      if (indexAsset) {
        const blob = await ctx.storage.get(indexAsset.storageKey);
        if (blob) {
          const origin = request.headers.get("origin");
          const cors = getCorsHeaders(origin);
          return new Response(blob, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
              ...cors,
            },
          });
        }
      }
    }

    return errorResponse(404, "Asset not found", request.headers.get("origin"));
  }

  const blob = await ctx.storage.get(asset.storageKey);
  if (!blob) {
    return errorResponse(404, "Asset storage missing", request.headers.get("origin"));
  }

  const origin = request.headers.get("origin");
  const cors = getCorsHeaders(origin);
  const contentType = asset.contentType || getContentType(assetPath);
  const cacheControl = getCacheControl(assetPath);

  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ...cors,
    },
  });
});

const gamesOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

export const registerGameRoutes = (http: HttpRouter) => {
  // Join redirect
  http.route({
    path: `${GAMES_BASE_PATH}/join`,
    method: "GET",
    handler: joinRedirectHandler,
  });

  // Catch-all for game assets — uses pathPrefix to match /games/*
  http.route({
    pathPrefix: `${GAMES_BASE_PATH}/`,
    method: "GET",
    handler: serveGameAsset,
  });

  http.route({
    pathPrefix: `${GAMES_BASE_PATH}/`,
    method: "OPTIONS",
    handler: gamesOptionsHandler,
  });
};
