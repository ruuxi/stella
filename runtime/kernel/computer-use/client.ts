import { randomUUID } from "node:crypto";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  type ComputerUseAction,
  type ComputerUseActionCommand,
  type ComputerUseAppPolicy,
  type ComputerUseAppSelector,
  type ComputerUseRequest,
  type ComputerUseTarget,
} from "./contract.js";
import {
  createCliDiagnosticsComputerUseSession,
  type CliDiagnosticsComputerUseSessionOptions,
} from "./cli-diagnostics-session.js";
import {
  executeComputerUseRequest,
  type ComputerUseSession,
} from "./session.js";

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

export type AuthorizeAppContext = Readonly<{
  selector: ComputerUseAppSelector;
  signal?: AbortSignal;
}>;

export type AuthorizeApp = (
  policy: ComputerUseAppPolicy,
  context: AuthorizeAppContext,
) => boolean | Promise<boolean>;

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

type CreateSkyClientCommonOptions = Readonly<{
  sessionId: string;
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
  authorizeApp?: AuthorizeApp;
}>;

export type CreateSkyClientWithSessionOptions = CreateSkyClientCommonOptions &
  Readonly<{
    session: ComputerUseSession;
  }>;

export type CreateSkyClientDiagnosticsOptions = CreateSkyClientCommonOptions &
  Omit<CliDiagnosticsComputerUseSessionOptions, "signal" | "getSignal">;

export type CreateSkyClientOptions = CreateSkyClientWithSessionOptions;

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

const requirePositiveInteger = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
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

const targetFrom = (args: CommonAction): ComputerUseTarget => {
  const app =
    args.app === undefined ? undefined : requireString(args.app, "app");
  if (args.window_id !== undefined) {
    const windowId = String(args.window_id).trim();
    if (!windowId) throw new Error("window_id must not be empty.");
    return { type: "window", windowId, ...(app ? { app } : {}) };
  }
  if (!app) throw new Error("app or window_id is required.");
  return { type: "app", app };
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

const clickAction = (args: ClickArgs): ComputerUseAction => {
  const hasElement = args.element_index !== undefined;
  const hasCoordinates = args.x !== undefined || args.y !== undefined;
  if (hasElement && hasCoordinates) {
    throw new Error("click must use either element_index or x/y, not both.");
  }
  const mouseButton = args.mouse_button ?? "left";
  const clickCount = requirePositiveInteger(
    args.click_count ?? 1,
    "click_count",
  );
  if (hasElement) {
    return {
      type: "click_element",
      elementId: elementId(args.element_index),
      mouseButton,
      clickCount,
    };
  }
  return {
    type: "click_point",
    point: {
      x: requireFinite(args.x, "x"),
      y: requireFinite(args.y, "y"),
    },
    mouseButton,
    clickCount,
  };
};

const dragAction = (args: DragArgs): ComputerUseAction => {
  if (args.path !== undefined) {
    if (
      args.from_x !== undefined ||
      args.from_y !== undefined ||
      args.to_x !== undefined ||
      args.to_y !== undefined
    ) {
      throw new Error(
        "drag must use either path or from/to coordinates, not both.",
      );
    }
    if (!Array.isArray(args.path) || args.path.length < 2) {
      throw new Error("path must contain at least two points.");
    }
    const first = args.path[0]!;
    const last = args.path[args.path.length - 1]!;
    return {
      type: "drag",
      from: {
        x: requireFinite(first.x, "path[0].x"),
        y: requireFinite(first.y, "path[0].y"),
      },
      to: {
        x: requireFinite(last.x, `path[${args.path.length - 1}].x`),
        y: requireFinite(last.y, `path[${args.path.length - 1}].y`),
      },
    };
  }
  return {
    type: "drag",
    from: {
      x: requireFinite(args.from_x, "from_x"),
      y: requireFinite(args.from_y, "from_y"),
    },
    to: {
      x: requireFinite(args.to_x, "to_x"),
      y: requireFinite(args.to_y, "to_y"),
    },
  };
};

const actionCommand = (entry: SkyAction): ComputerUseActionCommand => {
  if (!entry || typeof entry !== "object") {
    throw new Error("Each batch action must be an object.");
  }
  const target = targetFrom(entry);
  switch (entry.type) {
    case "click":
      return { target, action: clickAction(entry) };
    case "drag":
      return { target, action: dragAction(entry) };
    case "perform_secondary_action":
      return {
        target,
        action: {
          type: "perform_secondary_action",
          elementId: elementId(entry.element_index),
          action: requireString(entry.action, "action"),
        },
      };
    case "press_key":
      return {
        target,
        action: { type: "press_key", key: requireString(entry.key, "key") },
      };
    case "scroll":
      return {
        target,
        action: {
          type: "scroll",
          elementId: elementId(entry.element_index),
          direction: directionFromScroll(entry),
          pages: requirePositiveInteger(entry.pages ?? 1, "pages"),
        },
      };
    case "select_text":
      return {
        target,
        action: {
          type: "select_text",
          elementId: elementId(entry.element_index),
          text: requireString(entry.text, "text"),
          ...(entry.prefix === undefined ? {} : { prefix: entry.prefix }),
          ...(entry.suffix === undefined ? {} : { suffix: entry.suffix }),
          ...(entry.selection_type === undefined
            ? {}
            : { selectionType: entry.selection_type }),
        },
      };
    case "set_value":
      return {
        target,
        action: {
          type: "set_value",
          elementId: elementId(entry.element_index),
          value: String(entry.value ?? ""),
        },
      };
    case "type_text":
      return {
        target,
        action: {
          type: "type_text",
          text: requireString(entry.text, "text"),
        },
      };
    default:
      throw new Error(
        `Unsupported batch action: ${String((entry as { type?: unknown }).type)}`,
      );
  }
};

const singleAction = <TArgs extends CommonAction>(
  type: SkyAction["type"],
  args: TArgs,
) => actionCommand({ type, ...args } as SkyAction);

const instructionText = (instructions: string, text: string) =>
  [
    "<app_specific_instructions>",
    instructions,
    "</app_specific_instructions>",
    text,
  ]
    .filter(Boolean)
    .join("\n");

export const createSkyClient = (options: CreateSkyClientOptions): SkyClient => {
  const sessionId = requireString(options.sessionId, "sessionId");
  const session = options.session;
  const deliveredInstructions = new Set<string>();
  const sessionApprovedBundleIds = new Set<string>();
  const signal = () => options.getSignal?.() ?? options.signal;
  const envelope = () => ({
    schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
    protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
    requestId: randomUUID(),
    sessionId,
  });
  const execute = async <TRequest extends ComputerUseRequest>(
    request: TRequest,
  ) =>
    await executeComputerUseRequest(session, request, {
      signal: signal(),
    });

  const resolveTarget = async (
    selector: ComputerUseAppSelector,
  ): Promise<ComputerUseAppPolicy> => {
    const response = await execute({
      ...envelope(),
      type: "resolve_target",
      selector,
    });
    return response.policy;
  };

  const authorizePolicy = async (
    policy: ComputerUseAppPolicy,
    selector: ComputerUseAppSelector,
  ) => {
    const canonicalId = policy.bundleIdentifier.toLocaleLowerCase();
    if (policy.decision === "forbidden") {
      throw new Error(
        `${policy.displayName} is forbidden by computer-use policy.`,
      );
    }
    if (policy.decision === "denied") {
      throw new Error(
        `${policy.displayName} is denied by computer-use policy.`,
      );
    }
    if (sessionApprovedBundleIds.has(canonicalId)) return;
    if (!options.authorizeApp) {
      return;
    }
    const approved = await options.authorizeApp(policy, {
      selector,
      signal: signal(),
    });
    if (!approved) {
      throw new Error(
        `Computer-use authorization denied for ${policy.displayName}.`,
      );
    }
    sessionApprovedBundleIds.add(canonicalId);
  };

  const authorizeTarget = async (target: ComputerUseTarget) => {
    const policy = await resolveTarget(target);
    await authorizePolicy(policy, target);
    return policy;
  };

  const runAction = async (command: ComputerUseActionCommand) => {
    await authorizeTarget(command.target);
    const response = await execute({
      ...envelope(),
      type: "action",
      execution: "background",
      command,
    });
    return response.receipt;
  };

  const methods: SkyClient = {
    list_apps: async () => {
      const response = await execute({ ...envelope(), type: "list_apps" });
      return response.text;
    },
    list_windows: async () => {
      const response = await execute({ ...envelope(), type: "list_windows" });
      return response.text;
    },
    get_app_state: async (args: GetAppStateArgs): Promise<AppState> => {
      const target = targetFrom(args);
      const policy = await authorizeTarget(target);
      const response = await execute({
        ...envelope(),
        type: "get_app_state",
        target,
        screenshotPolicy: args.screenshot_policy ?? "auto",
        disableDiff: args.disable_diff === true || args.disableDiff === true,
      });
      const instructionKey = policy.bundleIdentifier.toLocaleLowerCase();
      const instructions = response.state.instructions?.trim();
      const shouldDeliverInstructions =
        Boolean(instructions) && !deliveredInstructions.has(instructionKey);
      if (shouldDeliverInstructions) {
        deliveredInstructions.add(instructionKey);
      }
      return {
        app: response.state.app,
        screenshot: response.state.screenshot
          ? { url: response.state.screenshot.url }
          : null,
        text:
          shouldDeliverInstructions && instructions
            ? instructionText(instructions, response.state.text)
            : response.state.text,
      };
    },
    click: async (args) => await runAction(singleAction("click", args)),
    drag: async (args) => await runAction(singleAction("drag", args)),
    perform_secondary_action: async (args) =>
      await runAction(singleAction("perform_secondary_action", args)),
    press_key: async (args) => await runAction(singleAction("press_key", args)),
    scroll: async (args) => await runAction(singleAction("scroll", args)),
    select_text: async (args) =>
      await runAction(singleAction("select_text", args)),
    set_value: async (args) => await runAction(singleAction("set_value", args)),
    type_text: async (args) => await runAction(singleAction("type_text", args)),
    batch: async (actions) => {
      if (!Array.isArray(actions)) throw new Error("actions must be an array.");
      const commands = actions.map(actionCommand);
      const policiesBySelector = new Map<string, ComputerUseAppPolicy>();
      const authorizationByBundle = new Map<
        string,
        { policy: ComputerUseAppPolicy; selector: ComputerUseAppSelector }
      >();
      for (const command of commands) {
        const selectorKey = JSON.stringify(command.target);
        let policy = policiesBySelector.get(selectorKey);
        if (!policy) {
          policy = await resolveTarget(command.target);
          policiesBySelector.set(selectorKey, policy);
        }
        const bundleKey = policy.bundleIdentifier.toLocaleLowerCase();
        if (!authorizationByBundle.has(bundleKey)) {
          authorizationByBundle.set(bundleKey, {
            policy,
            selector: command.target,
          });
        }
      }
      for (const { policy, selector } of authorizationByBundle.values()) {
        await authorizePolicy(policy, selector);
      }
      const response = await execute({
        ...envelope(),
        type: "batch",
        execution: "background",
        commands,
      });
      return [...response.receipt.receipts];
    },
  };

  return Object.freeze(methods);
};

export const createSkyClientForCliDiagnostics = (
  options: CreateSkyClientDiagnosticsOptions,
): SkyClient =>
  createSkyClient({
    sessionId: options.sessionId,
    session: createCliDiagnosticsComputerUseSession({
      cliPath: options.cliPath,
      cwd: options.cwd,
      runner: options.runner,
      env: options.env,
      signal: options.signal,
      getSignal: options.getSignal,
      commandTimeoutMs: options.commandTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }),
    signal: options.signal,
    getSignal: options.getSignal,
    authorizeApp: options.authorizeApp,
  });
