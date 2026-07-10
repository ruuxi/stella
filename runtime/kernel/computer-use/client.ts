import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ComputerCommandResult,
  ComputerCommandRunner,
} from "./command-runner.js";

const ATTACH_IMAGE_RE = /^\[stella-attach-image\].*$/gm;
const APP_INSTRUCTIONS_RE =
  /<app_specific_instructions>\s*([\s\S]*?)\s*<\/app_specific_instructions>\s*/g;

type CommonAction = {
  app?: string;
  window_id?: string | number;
};

export type SkyAction =
  | ({ type: "click" } & ClickArgs)
  | ({ type: "drag" } & DragArgs)
  | ({ type: "perform_secondary_action" } & SecondaryActionArgs)
  | ({ type: "press_key" } & PressKeyArgs)
  | ({ type: "scroll" } & ScrollArgs)
  | ({ type: "select_text" } & SelectTextArgs)
  | ({ type: "set_value" } & SetValueArgs)
  | ({ type: "type_text" } & TypeTextArgs);

export type ClickArgs = CommonAction & {
  element_index?: string | number;
  x?: number;
  y?: number;
  mouse_button?: "left" | "right" | "middle";
  click_count?: number;
};

export type DragArgs = CommonAction & {
  path?: Array<{ x: number; y: number }>;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
};

export type SecondaryActionArgs = CommonAction & {
  element_index: string | number;
  action: string;
};

export type PressKeyArgs = CommonAction & { key: string };

export type ScrollArgs = CommonAction & {
  element_index: string | number;
  direction?: "up" | "down" | "left" | "right";
  pages?: number;
  scroll_x?: number;
  scroll_y?: number;
};

export type SelectTextArgs = CommonAction & {
  element_index: string | number;
  text: string;
  prefix?: string;
  suffix?: string;
  selection_type?: "text" | "cursor-before" | "cursor-after";
};

export type SetValueArgs = CommonAction & {
  element_index: string | number;
  value: string;
};

export type TypeTextArgs = CommonAction & { text: string };

export type GetAppStateArgs = CommonAction & {
  screenshot_policy?: "auto" | "always" | "never";
  disable_diff?: boolean;
  disableDiff?: boolean;
};

export type AppState = {
  app: string;
  screenshot: { url: string } | null;
  text: string;
};

export type SkyClient = Readonly<{
  list_apps: () => Promise<string>;
  list_windows: () => Promise<string>;
  get_app_state: (args: GetAppStateArgs) => Promise<AppState>;
  click: (args: ClickArgs) => Promise<unknown>;
  drag: (args: DragArgs) => Promise<unknown>;
  perform_secondary_action: (args: SecondaryActionArgs) => Promise<unknown>;
  press_key: (args: PressKeyArgs) => Promise<unknown>;
  scroll: (args: ScrollArgs) => Promise<unknown>;
  select_text: (args: SelectTextArgs) => Promise<unknown>;
  set_value: (args: SetValueArgs) => Promise<unknown>;
  type_text: (args: TypeTextArgs) => Promise<unknown>;
  batch: (actions: SkyAction[]) => Promise<unknown[]>;
}>;

export type CreateSkyClientOptions = {
  cliPath?: string;
  sessionId: string;
  cwd: string;
  runner: ComputerCommandRunner;
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const requireFinite = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
};

const elementId = (value: unknown): string => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error("element_index is required.");
  }
  return String(value);
};

const parseJsonResult = (result: ComputerCommandResult): unknown => {
  let payload: unknown;
  try {
    payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    throw new Error(
      `stella-computer returned invalid JSON: ${result.stdout.trim() || result.stderr.trim()}`,
    );
  }
  if (result.exitCode !== 0) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : result.stderr.trim() || `stella-computer exited ${result.exitCode}.`;
    throw new Error(message);
  }
  return payload;
};

const directionFromScroll = (args: ScrollArgs) => {
  if (args.direction) return args.direction;
  const x = args.scroll_x ?? 0;
  const y = args.scroll_y ?? 0;
  if (x === 0 && y === 0) return "down";
  return Math.abs(y) >= Math.abs(x)
    ? y < 0
      ? "up"
      : "down"
    : x < 0
      ? "left"
      : "right";
};

export const createSkyClient = (options: CreateSkyClientOptions): SkyClient => {
  const deliveredInstructions = new Set<string>();
  const resourceAnchor =
    options.cliPath ??
    fileURLToPath(new URL("../cli/stella-computer.js", import.meta.url));
  const childEnv = process.versions.electron
    ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    : process.env;
  const run = async (args: string[]) =>
    await options.runner({
      command: process.execPath,
      args: [resourceAnchor, "--session", options.sessionId, ...args],
      cwd: options.cwd,
      env: childEnv,
      signal: options.getSignal?.() ?? options.signal,
      timeoutMs: options.commandTimeoutMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes,
    });
  const action = async (command: string, args: string[]) =>
    parseJsonResult(
      await run([command, ...args, "--defer-observation", "--json"]),
    );
  const withTarget = (args: CommonAction) => {
    const target: string[] = [];
    if (args.app !== undefined) {
      target.push("--app", requireString(args.app, "app"));
    }
    if (args.window_id !== undefined) {
      const value = String(args.window_id).trim();
      if (!value) throw new Error("window_id must not be empty.");
      target.push("--window-id", value);
    }
    if (target.length === 0) throw new Error("app or window_id is required.");
    return target;
  };

  const methods = {
    list_apps: async () => {
      const result = await run(["list-apps"]);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || `stella-computer exited ${result.exitCode}.`,
        );
      }
      return result.stdout.trim();
    },
    list_windows: async () => {
      const result = await run(["list-windows"]);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || `stella-computer exited ${result.exitCode}.`,
        );
      }
      return result.stdout.trim();
    },
    get_app_state: async (args: GetAppStateArgs): Promise<AppState> => {
      const command = ["get-state", ...withTarget(args)];
      const app = args.app ?? `window-id:${String(args.window_id)}`;
      command.push("--no-inline-screenshot");
      command.push("--screenshot-policy", args.screenshot_policy ?? "auto");
      if (args.disable_diff === true || args.disableDiff === true) {
        command.push("--disable-diff");
      }
      const result = await run(command);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || `stella-computer exited ${result.exitCode}.`,
        );
      }

      let screenshotPath: string | null = null;
      let text = result.stdout.replace(ATTACH_IMAGE_RE, (marker) => {
        const assignedPath = /\bpath=("(?:\\.|[^"\\])*")/.exec(marker)?.[1];
        let candidate = "";
        if (assignedPath) {
          try {
            candidate = String(JSON.parse(assignedPath));
          } catch {
            candidate = "";
          }
        } else {
          candidate =
            /\s((?:\/|[A-Za-z]:[\\/]).*\.(?:png|jpg|jpeg|gif|webp))$/i
              .exec(marker)?.[1]
              ?.trim() ?? "";
        }
        if (path.isAbsolute(candidate)) screenshotPath = candidate;
        return "";
      });
      const instructionKey = app.toLocaleLowerCase();
      text = text.replace(APP_INSTRUCTIONS_RE, (full) => {
        if (deliveredInstructions.has(instructionKey)) return "";
        deliveredInstructions.add(instructionKey);
        return full;
      });

      return {
        app,
        screenshot: screenshotPath
          ? { url: pathToFileURL(screenshotPath).href }
          : null,
        text: text.trim(),
      };
    },
    click: async (args: ClickArgs) => {
      const common = withTarget(args);
      const clickOptions = [
        "--mouse-button",
        args.mouse_button ?? "left",
        "--click-count",
        String(args.click_count ?? 1),
      ];
      if (args.element_index !== undefined) {
        return await action("click", [
          elementId(args.element_index),
          ...common,
          ...clickOptions,
        ]);
      }
      return await action("click-screenshot", [
        String(requireFinite(args.x, "x")),
        String(requireFinite(args.y, "y")),
        ...common,
        ...clickOptions,
        "--raise",
      ]);
    },
    drag: async (args: DragArgs) => {
      const first = args.path?.[0];
      const last = args.path?.[args.path.length - 1];
      const fromX = first?.x ?? args.from_x;
      const fromY = first?.y ?? args.from_y;
      const toX = last?.x ?? args.to_x;
      const toY = last?.y ?? args.to_y;
      return await action("drag-screenshot", [
        String(requireFinite(fromX, "from_x")),
        String(requireFinite(fromY, "from_y")),
        String(requireFinite(toX, "to_x")),
        String(requireFinite(toY, "to_y")),
        ...withTarget(args),
        "--allow-hid",
        "--raise",
      ]);
    },
    perform_secondary_action: async (args: SecondaryActionArgs) =>
      await action("secondary-action", [
        elementId(args.element_index),
        requireString(args.action, "action"),
        ...withTarget(args),
      ]),
    press_key: async (args: PressKeyArgs) =>
      await action("press", [
        requireString(args.key, "key"),
        ...withTarget(args),
        "--allow-hid",
        "--raise",
      ]),
    scroll: async (args: ScrollArgs) =>
      await action("scroll", [
        elementId(args.element_index),
        directionFromScroll(args),
        ...withTarget(args),
        "--pages",
        String(args.pages ?? 1),
      ]),
    select_text: async (args: SelectTextArgs) => {
      const command = [
        elementId(args.element_index),
        requireString(args.text, "text"),
        ...withTarget(args),
      ];
      if (args.prefix !== undefined) command.push("--prefix", args.prefix);
      if (args.suffix !== undefined) command.push("--suffix", args.suffix);
      if (args.selection_type !== undefined) {
        command.push("--selection", args.selection_type);
      }
      return await action("select-text", command);
    },
    set_value: async (args: SetValueArgs) =>
      await action("fill", [
        elementId(args.element_index),
        String(args.value ?? ""),
        ...withTarget(args),
      ]),
    type_text: async (args: TypeTextArgs) =>
      await action("type", [
        requireString(args.text, "text"),
        ...withTarget(args),
        "--allow-hid",
        "--raise",
      ]),
    batch: async (actions: SkyAction[]) => {
      if (!Array.isArray(actions)) throw new Error("actions must be an array.");
      const results: unknown[] = [];
      for (const entry of actions) {
        if (!entry || typeof entry !== "object") {
          throw new Error("Each batch action must be an object.");
        }
        const method = methods[entry.type] as
          | ((args: never) => Promise<unknown>)
          | undefined;
        if (!method) {
          throw new Error(`Unsupported batch action: ${String(entry.type)}`);
        }
        results.push(await method(entry as never));
      }
      return results;
    },
  } satisfies Record<string, (...args: never[]) => unknown>;

  return Object.freeze(methods) as SkyClient;
};
