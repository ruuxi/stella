/**
 * `stella-canvas://library` — local protocol behind the canvas library.
 *
 * Serves three kinds of content to the Canvas tab's iframe:
 *   - the app-owned library shell (index.html/app.js/style.css under
 *     `desktop/resources/library-shell`, shipped via extraResources)
 *   - the merged manifest index (`/manifest.json`), built from the
 *     html tool's manifest plus a directory backfill for legacy pages
 *   - the model-generated pages themselves (`/a/<slug>`), with the
 *     selection-bridge script injected so "Ask Stella" selections keep
 *     working inside the nested artifact iframe
 *
 * Scheme registration must happen before `app.whenReady()`
 * (`registerCanvasLibraryScheme`), the handler after
 * (`installCanvasLibraryProtocol`).
 */

import path from "node:path";
import fs from "node:fs/promises";
import { app, protocol, session } from "electron";
import { buildCanvasLibraryIndex } from "../../../runtime/kernel/shared/canvas-library-manifest.js";

export const CANVAS_LIBRARY_SCHEME = "stella-canvas";
export const CANVAS_LIBRARY_HOST = "library";
export const CANVAS_LIBRARY_URL = `${CANVAS_LIBRARY_SCHEME}://${CANVAS_LIBRARY_HOST}/`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SHELL_ASSETS: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/artifact-bridge.js": "artifact-bridge.js",
};

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const mimeFor = (filePath: string): string =>
  MIME_BY_EXT[path.extname(filePath).toLowerCase()] ??
  "application/octet-stream";

const resolveShellDir = (stellaAppDir: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "library-shell")
    : path.join(stellaAppDir, "desktop", "resources", "library-shell");

const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });

const fileResponse = async (filePath: string): Promise<Response> => {
  try {
    const body = await fs.readFile(filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": mimeFor(filePath),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return notFound();
  }
};

const ARTIFACT_BRIDGE_TAG = '<script src="/artifact-bridge.js"></script>';

const injectArtifactBridge = (html: string): string =>
  /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${ARTIFACT_BRIDGE_TAG}</body>`)
    : `${html}${ARTIFACT_BRIDGE_TAG}`;

export const registerCanvasLibraryScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CANVAS_LIBRARY_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
};

export type CanvasLibraryProtocolOptions = {
  stellaDataDir: string;
  stellaAppDir: string;
  sessionPartition: string;
};

export const installCanvasLibraryProtocol = (
  options: CanvasLibraryProtocolOptions,
): void => {
  const shellDir = resolveShellDir(options.stellaAppDir);
  const htmlDir = path.join(options.stellaDataDir, "outputs", "html");

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== CANVAS_LIBRARY_HOST) return notFound();
    const pathname = url.pathname;

    const shellAsset = SHELL_ASSETS[pathname];
    if (shellAsset) {
      return fileResponse(path.join(shellDir, shellAsset));
    }

    if (pathname === "/manifest.json") {
      const index = await buildCanvasLibraryIndex(options.stellaDataDir);
      return new Response(JSON.stringify(index), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const artifactMatch = /^\/a\/([^/]+)$/.exec(pathname);
    if (artifactMatch) {
      const slug = artifactMatch[1] ?? "";
      if (!SLUG_RE.test(slug)) return notFound();
      try {
        const html = await fs.readFile(
          path.join(htmlDir, `${slug}.html`),
          "utf8",
        );
        return new Response(injectArtifactBridge(html), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch {
        return notFound();
      }
    }

    return notFound();
  };

  const sessions = [
    session.defaultSession,
    session.fromPartition(options.sessionPartition),
  ];
  for (const ses of sessions) {
    if (!ses.protocol.isProtocolHandled(CANVAS_LIBRARY_SCHEME)) {
      ses.protocol.handle(CANVAS_LIBRARY_SCHEME, handler);
    }
  }
};
