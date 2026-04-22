/**
 * Typed `computer_*` tool surface.
 *
 * The model calls these as first-class tools (no shell, no SKILL doc, no
 * argv parsing on the model side). Each handler shells out to the existing
 * `stella-computer` CLI wrapper which already encapsulates the daemon
 * lifecycle, target resolution, AX dispatch, screenshot capture, and the
 * `[stella-attach-image]` marker contract that the agent runtime uses to
 * surface inline screenshots on the next turn.
 *
 * Tool surface intentionally mirrors the upstream computer-use MCP shape so
 * the model can transfer skill 1:1: list_apps, get_app_state, click, drag,
 * perform_secondary_action, press_key, scroll, set_value, type_text.
 */

import { spawn } from "node:child_process";

import { getStellaComputerSessionId } from "./stella-computer-session.js";
import type { ToolContext, ToolHandler, ToolResult } from "./types.js";

const COMPUTER_TOOL_TIMEOUT_MS = 60_000;

const requireString = (
  args: Record<string, unknown>,
  key: string,
): { value: string } | { error: string } => {
  const raw = args[key];
  if (typeof raw !== "string") {
    return { error: `${key} is required and must be a string.` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: `${key} is required and must be a non-empty string.` };
  }
  return { value: trimmed };
};

const requireNumber = (
  args: Record<string, unknown>,
  key: string,
): { value: number } | { error: string } => {
  const raw = args[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { error: `${key} is required and must be a finite number.` };
  }
  return { value: raw };
};

const runStellaComputer = (
  cliPath: string,
  argv: string[],
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> =>
  new Promise((resolve) => {
    const sessionId = getStellaComputerSessionId(context);
    const env = {
      ...process.env,
      ...(sessionId ? { STELLA_COMPUTER_SESSION: sessionId } : {}),
    };
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let settled = false;
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      settle({ error: "computer_* call was aborted." });
    };
    signal?.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      settle({
        error: `computer_* call timed out after ${COMPUTER_TOOL_TIMEOUT_MS}ms.`,
        details: { stdout, stderr },
      });
    }, COMPUTER_TOOL_TIMEOUT_MS);

    child.on("error", (error) => {
      settle({
        error: `computer_* spawn failed: ${(error as Error).message}`,
        details: { stdout, stderr },
      });
    });

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : -1;
      if (exitCode === 0) {
        settle({
          result: stdout.trimEnd(),
          details: { exit_code: exitCode, stderr: stderr.trim() || undefined },
        });
        return;
      }
      const message =
        stderr.trim() || stdout.trim() || `computer_* exited ${exitCode}.`;
      settle({
        error: message,
        details: { exit_code: exitCode, stdout, stderr },
      });
    });
  });

export type CreateComputerToolHandlersOptions = {
  stellaComputerCliPath?: string;
};

const unavailable = (toolName: string): ToolResult => ({
  error: `${toolName} is unavailable: stella-computer CLI is not configured for this runtime.`,
});

export const createComputerToolHandlers = (
  options: CreateComputerToolHandlersOptions,
): Record<string, ToolHandler> => {
  const cliPath = options.stellaComputerCliPath;
  if (!cliPath) {
    const noop = (toolName: string): ToolHandler =>
      async () => unavailable(toolName);
    return {
      computer_list_apps: noop("computer_list_apps"),
      computer_get_app_state: noop("computer_get_app_state"),
      computer_click: noop("computer_click"),
      computer_drag: noop("computer_drag"),
      computer_perform_secondary_action: noop("computer_perform_secondary_action"),
      computer_press_key: noop("computer_press_key"),
      computer_scroll: noop("computer_scroll"),
      computer_set_value: noop("computer_set_value"),
      computer_type_text: noop("computer_type_text"),
    };
  }

  return {
    computer_list_apps: async (_args, context, extras) =>
      runStellaComputer(cliPath, ["list-apps"], context, extras?.signal),

    computer_get_app_state: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      return runStellaComputer(
        cliPath,
        ["snapshot", "--app", app.value],
        context,
        extras?.signal,
      );
    },

    computer_click: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;

      const elementRaw = args.element_index;
      const hasElement = typeof elementRaw === "string" && elementRaw.trim().length > 0;
      const xRaw = args.x;
      const yRaw = args.y;
      const hasCoords = typeof xRaw === "number" && typeof yRaw === "number";

      if (!hasElement && !hasCoords) {
        return { error: "computer_click requires either element_index or both x and y." };
      }
      if (hasElement && hasCoords) {
        return { error: "computer_click accepts element_index OR x/y, not both." };
      }

      const button =
        typeof args.mouse_button === "string" ? args.mouse_button : "left";
      if (button !== "left") {
        return {
          error: `mouse_button=${button} is not yet supported (left only).`,
        };
      }
      const clickCount =
        typeof args.click_count === "number" ? args.click_count : 1;
      if (clickCount !== 1) {
        return {
          error: `click_count=${clickCount} is not yet supported (1 only).`,
        };
      }

      if (hasElement) {
        return runStellaComputer(
          cliPath,
          ["click", "--app", app.value, String(elementRaw).trim()],
          context,
          extras?.signal,
        );
      }
      // Pixel-coordinate click: interpret x/y as screenshot pixels and let the
      // wrapper map them back into the captured window's coordinate space.
      return runStellaComputer(
        cliPath,
        [
          "click-screenshot",
          "--app",
          app.value,
          String(xRaw),
          String(yRaw),
          "--allow-hid",
        ],
        context,
        extras?.signal,
      );
    },

    computer_drag: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const fromX = requireNumber(args, "from_x");
      if ("error" in fromX) return fromX;
      const fromY = requireNumber(args, "from_y");
      if ("error" in fromY) return fromY;
      const toX = requireNumber(args, "to_x");
      if ("error" in toX) return toX;
      const toY = requireNumber(args, "to_y");
      if ("error" in toY) return toY;

      return runStellaComputer(
        cliPath,
        [
          "drag-screenshot",
          "--app",
          app.value,
          String(fromX.value),
          String(fromY.value),
          String(toX.value),
          String(toY.value),
          "--allow-hid",
        ],
        context,
        extras?.signal,
      );
    },

    computer_perform_secondary_action: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const elementIndex = requireString(args, "element_index");
      if ("error" in elementIndex) return elementIndex;
      const action = requireString(args, "action");
      if ("error" in action) return action;

      return runStellaComputer(
        cliPath,
        [
          "secondary-action",
          "--app",
          app.value,
          elementIndex.value,
          action.value,
        ],
        context,
        extras?.signal,
      );
    },

    computer_press_key: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const key = requireString(args, "key");
      if ("error" in key) return key;

      return runStellaComputer(
        cliPath,
        ["press", "--app", app.value, key.value, "--allow-hid"],
        context,
        extras?.signal,
      );
    },

    computer_scroll: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const elementIndex = requireString(args, "element_index");
      if ("error" in elementIndex) return elementIndex;
      const direction = requireString(args, "direction");
      if ("error" in direction) return direction;
      if (
        direction.value !== "up" &&
        direction.value !== "down" &&
        direction.value !== "left" &&
        direction.value !== "right"
      ) {
        return {
          error: `direction must be one of: up, down, left, right (got ${direction.value}).`,
        };
      }

      const argv = [
        "scroll",
        "--app",
        app.value,
        elementIndex.value,
        direction.value,
      ];
      if (typeof args.pages === "number" && Number.isFinite(args.pages)) {
        argv.push("--pages", String(args.pages));
      }
      return runStellaComputer(cliPath, argv, context, extras?.signal);
    },

    computer_set_value: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const elementIndex = requireString(args, "element_index");
      if ("error" in elementIndex) return elementIndex;
      const value = typeof args.value === "string" ? args.value : "";

      return runStellaComputer(
        cliPath,
        ["fill", "--app", app.value, elementIndex.value, value],
        context,
        extras?.signal,
      );
    },

    computer_type_text: async (args, context, extras) => {
      const app = requireString(args, "app");
      if ("error" in app) return app;
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required and must be a non-empty string." };
      }

      return runStellaComputer(
        cliPath,
        ["type", "--app", app.value, text, "--allow-hid"],
        context,
        extras?.signal,
      );
    },
  };
};
