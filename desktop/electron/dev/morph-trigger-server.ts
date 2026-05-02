/**
 * Dev-only HTTP listener that triggers the same self-mod morph transition
 * (`hmrTransitionController.runTransition`) without an actual file change,
 * so the capture/morph animation can be tested from the terminal:
 *
 *   bun run morph:test           # default hold of 1500ms
 *   bun run morph:test -- --hold 600
 *   bun run morph:test -- --reload
 *
 * Listens on 127.0.0.1 only and is started exclusively in dev (`config.isDev`).
 */

import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HmrTransitionController } from "../self-mod/hmr-morph.js";

export const DEFAULT_MORPH_TRIGGER_PORT = 57316;

type TriggerDeps = {
  getHmrTransitionController: () => HmrTransitionController | null;
};

type StartOptions = TriggerDeps & {
  port?: number;
};

export type MorphTriggerServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

export const startMorphTriggerServer = async (
  options: StartOptions,
): Promise<MorphTriggerServerHandle | null> => {
  const port = options.port ?? DEFAULT_MORPH_TRIGGER_PORT;

  const handleTrigger = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const holdMsRaw = url.searchParams.get("holdMs");
    const holdMs = (() => {
      const parsed = holdMsRaw == null ? NaN : Number(holdMsRaw);
      if (!Number.isFinite(parsed)) return 1500;
      return Math.max(0, Math.min(10_000, Math.round(parsed)));
    })();
    const requiresFullReload =
      url.searchParams.get("reload") === "1" ||
      url.searchParams.get("reload") === "true";

    const controller = options.getHmrTransitionController();
    if (!controller) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ ok: false, reason: "hmr-controller-unavailable" }),
      );
      return;
    }

    try {
      await controller.runTransition({
        runIds: ["dev-morph-trigger"],
        applyBatch: async () => {
          await delay(holdMs);
        },
        requiresFullReload,
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, holdMs, requiresFullReload }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          reason: "transition-failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/trigger-morph") {
      void handleTrigger(req, res);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          endpoints: ["POST /trigger-morph?holdMs=1500&reload=0"],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  return await new Promise<MorphTriggerServerHandle | null>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      console.warn("[morph-trigger-server] failed to start:", {
        port,
        code: error.code,
        message: error.message,
      });
      server.removeListener("error", onError);
      resolve(null);
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address() as AddressInfo | null;
      const boundPort = addr?.port ?? port;
      console.info(
        `[morph-trigger-server] listening on http://127.0.0.1:${boundPort}/trigger-morph`,
      );
      resolve({
        port: boundPort,
        stop: () =>
          new Promise<void>((resolveStop) => {
            server.close(() => resolveStop());
          }),
      });
    });
  });
};
