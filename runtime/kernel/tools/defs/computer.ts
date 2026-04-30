/**
 * Desktop computer-use tools.
 *
 * Nine sibling tools that drive the user's apps through the `stella-computer`
 * CLI. macOS uses Accessibility + ScreenCaptureKit; Windows uses UI
 * Automation first with Win32 window-message fallbacks. Surface
 * mirrors the upstream computer-use MCP shape so model skill transfers 1:1:
 * `computer_list_apps`, `computer_get_app_state`, `computer_click`,
 * `computer_drag`, `computer_perform_secondary_action`, `computer_press_key`,
 * `computer_scroll`, `computer_set_value`, `computer_type_text`.
 *
 * The nine handlers share `runStellaComputer` (CLI spawn, timeout, abort
 * plumbing) and a tiny set of arg validators, so they live together rather
 * than in nine near-identical files. Each entry below owns its own name,
 * description, JSON schema, and execute closure.
 */

import { spawn } from "node:child_process";

import { getStellaComputerSessionId } from "../stella-computer-session.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolResult,
} from "../types.js";

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

export type ComputerToolOptions = {
  stellaComputerCliPath?: string;
};

const COMPUTER_APP_PROPERTY = {
  type: "string",
  description:
    'The target desktop app. Use the display name ("Spotify", "Notepad") or platform identifier ("com.spotify.client", "notepad.exe"). Required on every call.',
};

const unavailableHandler =
  (toolName: string): ToolHandler =>
  async () => ({
    error: `${toolName} is unavailable: stella-computer CLI is not configured for this runtime.`,
  });

const cliExecutor =
  (cliPath: string, build: (args: Record<string, unknown>) => string[] | ToolResult): ToolHandler =>
  async (args, context, extras) => {
    const argv = build(args);
    if (!Array.isArray(argv)) return argv;
    return runStellaComputer(cliPath, argv, context, extras?.signal);
  };

export const createComputerTools = (
  options: ComputerToolOptions,
): ToolDefinition[] => {
  const cliPath = options.stellaComputerCliPath;

  const handler = (
    toolName: string,
    build: (args: Record<string, unknown>) => string[] | ToolResult,
  ): ToolHandler =>
    cliPath ? cliExecutor(cliPath, build) : unavailableHandler(toolName);

  const tools: ToolDefinition[] = [
    {
      name: "computer_list_apps",
      description:
        "List the apps on this device. macOS returns running + recently used apps; Windows returns running top-level apps. Includes app name, identifier, pid, and available state details.",
      promptSnippet: "List installed/running desktop apps",
      parameters: { type: "object", properties: {} },
      execute: handler("computer_list_apps", () => ["list-apps"]),
    },
    {
      name: "computer_get_app_state",
      description:
        "Start a computer-use session for an app if needed, then return its current accessibility tree (compact numbered element list) and a screenshot of its key window. Call this once per turn before interacting with the app. Required: app.",
      promptSnippet: "Snapshot a desktop app's UI before acting on it",
      parameters: {
        type: "object",
        properties: { app: COMPUTER_APP_PROPERTY },
        required: ["app"],
      },
      execute: handler("computer_get_app_state", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        return ["snapshot", "--app", app.value];
      }),
    },
    {
      name: "computer_click",
      description:
        "Click an element of the target app. Both forms work while the target app stays in the background. Use element_index when the visible UI is exposed in the accessibility tree from the latest get_app_state — that's the most precise. Use x/y (screenshot pixel coordinates) when the element you need is visible in the screenshot but not addressable via element_index, which is common for web-view-backed apps (Spotify, Slack, Discord, Notion, Linear). Required: app.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          element_index: {
            type: "string",
            description:
              "Numeric ID of the element to click, taken from the most recent get_app_state output. Preferred when the element exists in the AX tree — it's labeled, deterministic, and resilient to layout shifts. Provide either element_index or x/y, not both.",
          },
          x: {
            type: "number",
            description:
              "X pixel coordinate inside the most recent screenshot. Use this when the visible element you want is not in the accessibility tree (which is common for the main content area of web-view apps). A single x/y click works in the background; pair it with y. Provide either element_index or x/y, not both.",
          },
          y: {
            type: "number",
            description:
              "Y pixel coordinate inside the most recent screenshot. Pair with x.",
          },
          click_count: {
            type: "integer",
            description:
              "Number of clicks (1 = single click, 2 = double click, ...). Default 1. Avoid click_count >= 2 against web-view apps (Spotify song rows, Slack list items, Discord channels, etc.) while they are in the background — synthesized double-clicks via x/y are silently dropped by those UIs. Look for a single-click affordance (play button, expand chevron) instead.",
          },
          mouse_button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button. Default 'left'.",
          },
        },
        required: ["app"],
      },
      execute: handler("computer_click", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };

        const elementRaw = args.element_index;
        const hasElement =
          typeof elementRaw === "string" && elementRaw.trim().length > 0;
        const xRaw = args.x;
        const yRaw = args.y;
        const hasCoords = typeof xRaw === "number" && typeof yRaw === "number";

        if (!hasElement && !hasCoords) {
          return {
            error:
              "computer_click requires either element_index or both x and y.",
          };
        }
        if (hasElement && hasCoords) {
          return { error: "computer_click accepts element_index OR x/y, not both." };
        }

        const button =
          typeof args.mouse_button === "string" ? args.mouse_button : "left";
        if (button !== "left" && button !== "right" && button !== "middle") {
          return {
            error: `mouse_button must be one of: left, right, middle (got ${button}).`,
          };
        }

        const clickCountRaw = args.click_count;
        const clickCount =
          typeof clickCountRaw === "number" && Number.isFinite(clickCountRaw) && clickCountRaw >= 1
            ? Math.trunc(clickCountRaw)
            : 1;

        if (hasElement) {
          // Element-targeted click goes through the AX `click` command
          // which today wires straight into the AX press path; mouse
          // button + click count modifiers attached as flags.
          const argv = ["click", "--app", app.value, String(elementRaw).trim()];
          if (button !== "left") argv.push("--mouse-button", button);
          if (clickCount !== 1) argv.push("--click-count", String(clickCount));
          return argv;
        }
        // Pixel-coordinate click: screenshot pixels remapped into the
        // captured window's coordinate space by the CLI wrapper, then
        // dispatched via the click-point pipeline.
        const argv = [
          "click-screenshot",
          "--app",
          app.value,
          String(xRaw),
          String(yRaw),
          "--allow-hid",
        ];
        if (button !== "left") argv.push("--mouse-button", button);
        if (clickCount !== 1) argv.push("--click-count", String(clickCount));
        return argv;
      }),
    },
    {
      name: "computer_drag",
      description:
        "Drag from one screenshot pixel to another inside the target app's captured window. Required: app, from_x, from_y, to_x, to_y.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          from_x: { type: "number", description: "Start X pixel in the screenshot." },
          from_y: { type: "number", description: "Start Y pixel in the screenshot." },
          to_x: { type: "number", description: "End X pixel in the screenshot." },
          to_y: { type: "number", description: "End Y pixel in the screenshot." },
        },
        required: ["app", "from_x", "from_y", "to_x", "to_y"],
      },
      execute: handler("computer_drag", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const fromX = requireNumber(args, "from_x");
        if ("error" in fromX) return { error: fromX.error };
        const fromY = requireNumber(args, "from_y");
        if ("error" in fromY) return { error: fromY.error };
        const toX = requireNumber(args, "to_x");
        if ("error" in toX) return { error: toX.error };
        const toY = requireNumber(args, "to_y");
        if ("error" in toY) return { error: toY.error };
        return [
          "drag-screenshot",
          "--app",
          app.value,
          String(fromX.value),
          String(fromY.value),
          String(toX.value),
          String(toY.value),
          "--allow-hid",
        ];
      }),
    },
    {
      name: "computer_perform_secondary_action",
      description:
        "Invoke a secondary Accessibility action (e.g. AXPress on a menu item, AXRaise on a window) exposed by an element. Required: app, element_index, action.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          element_index: {
            type: "string",
            description:
              "Numeric ID of the element from the most recent get_app_state output.",
          },
          action: {
            type: "string",
            description:
              "AX action name to invoke (e.g. AXPress, AXRaise, AXShowMenu). The element's get_app_state line lists its supported Secondary Actions.",
          },
        },
        required: ["app", "element_index", "action"],
      },
      execute: handler("computer_perform_secondary_action", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const elementIndex = requireString(args, "element_index");
        if ("error" in elementIndex) return { error: elementIndex.error };
        const action = requireString(args, "action");
        if ("error" in action) return { error: action.error };
        return [
          "secondary-action",
          "--app",
          app.value,
          elementIndex.value,
          action.value,
        ];
      }),
    },
    {
      name: "computer_press_key",
      description:
        "Press a key or key combination on the keyboard with the target app focused. Supports modifiers (cmd, shift, ctrl, alt) and named keys (Return, Tab, Up, Down, etc). Required: app, key.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          key: {
            type: "string",
            description:
              "Key or key combination (e.g. 'Return', 'Tab', 'cmd+f', 'cmd+shift+l').",
          },
        },
        required: ["app", "key"],
      },
      execute: handler("computer_press_key", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const key = requireString(args, "key");
        if ("error" in key) return { error: key.error };
        return ["press", "--app", app.value, key.value, "--allow-hid"];
      }),
    },
    {
      name: "computer_scroll",
      description:
        "Scroll an element of the target app in a direction by a number of pages. Required: app, element_index, direction (up|down|left|right).",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          element_index: {
            type: "string",
            description:
              "Numeric ID of the scrollable element from the most recent get_app_state output.",
          },
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Scroll direction.",
          },
          pages: {
            type: "number",
            description: "Number of pages to scroll. Default 1.",
          },
        },
        required: ["app", "element_index", "direction"],
      },
      execute: handler("computer_scroll", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const elementIndex = requireString(args, "element_index");
        if ("error" in elementIndex) return { error: elementIndex.error };
        const direction = requireString(args, "direction");
        if ("error" in direction) return { error: direction.error };
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
        return argv;
      }),
    },
    {
      name: "computer_set_value",
      description:
        "Set the value of a settable Accessibility element (text field, search field, switch, slider). Deterministic — does not depend on focus. Required: app, element_index, value.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          element_index: {
            type: "string",
            description:
              "Numeric ID of the settable element (text field, search field, switch, slider).",
          },
          value: {
            type: "string",
            description: "New value to set. May be empty to clear the field.",
          },
        },
        required: ["app", "element_index", "value"],
      },
      execute: handler("computer_set_value", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const elementIndex = requireString(args, "element_index");
        if ("error" in elementIndex) return { error: elementIndex.error };
        const value = typeof args.value === "string" ? args.value : "";
        return ["fill", "--app", app.value, elementIndex.value, value];
      }),
    },
    {
      name: "computer_type_text",
      description:
        "Type literal text via the keyboard into the target app. Required: app, text.",
      parameters: {
        type: "object",
        properties: {
          app: COMPUTER_APP_PROPERTY,
          text: { type: "string", description: "Literal text to type." },
        },
        required: ["app", "text"],
      },
      execute: handler("computer_type_text", (args) => {
        const app = requireString(args, "app");
        if ("error" in app) return { error: app.error };
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) {
          return { error: "text is required and must be a non-empty string." };
        }
        return ["type", "--app", app.value, text, "--allow-hid"];
      }),
    },
  ];

  return tools;
};
