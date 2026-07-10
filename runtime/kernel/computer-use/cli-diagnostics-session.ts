import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  assertComputerUseRequest,
  assertJsonSafe,
  type ComputerUseActionCommand,
  type ComputerUseActionReceipt,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseTarget,
  type JsonObject,
} from "./contract.js";
import type { ComputerUseSession } from "./session.js";
import type {
  ComputerCommandResult,
  ComputerCommandRunner,
} from "./command-runner.js";

const ATTACH_IMAGE_RE = /^\[stella-attach-image\].*$/gm;
const APP_INSTRUCTIONS_RE =
  /<app_specific_instructions>\s*([\s\S]*?)\s*<\/app_specific_instructions>\s*/g;

export type CliDiagnosticsComputerUseSessionOptions = Readonly<{
  cliPath?: string;
  cwd: string;
  runner: ComputerCommandRunner;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}>;

const responseEnvelope = (request: ComputerUseRequest) => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const errorResponse = (
  request: ComputerUseRequest,
  code: string,
  message: string,
  retryable = false,
): Extract<ComputerUseResponse, { type: "error" }> => ({
  ...responseEnvelope(request),
  type: "error",
  error: { code, message, retryable },
});

const targetArgs = (target: ComputerUseTarget): string[] => {
  if (target.type === "app") return ["--app", target.app];
  return [
    ...(target.app ? ["--app", target.app] : []),
    "--window-id",
    target.windowId,
  ];
};

const encodeAction = (command: ComputerUseActionCommand): string[] => {
  const target = targetArgs(command.target);
  const action = command.action;
  switch (action.type) {
    case "click_element":
      return [
        "click",
        action.elementId,
        ...target,
        "--mouse-button",
        action.mouseButton,
        "--click-count",
        String(action.clickCount),
      ];
    case "click_point":
      return [
        "click-screenshot",
        String(action.point.x),
        String(action.point.y),
        ...target,
        "--mouse-button",
        action.mouseButton,
        "--click-count",
        String(action.clickCount),
      ];
    case "drag":
      return [
        "drag-screenshot",
        String(action.from.x),
        String(action.from.y),
        String(action.to.x),
        String(action.to.y),
        ...target,
        "--allow-hid",
      ];
    case "perform_secondary_action":
      return ["secondary-action", action.elementId, action.action, ...target];
    case "press_key":
      return ["press", action.key, ...target, "--allow-hid"];
    case "scroll":
      return [
        "scroll",
        action.elementId,
        action.direction,
        ...target,
        "--pages",
        String(action.pages),
      ];
    case "select_text":
      return [
        "select-text",
        action.elementId,
        action.text,
        ...target,
        ...(action.prefix === undefined ? [] : ["--prefix", action.prefix]),
        ...(action.suffix === undefined ? [] : ["--suffix", action.suffix]),
        ...(action.selectionType === undefined
          ? []
          : ["--selection", action.selectionType]),
      ];
    case "set_value":
      return ["fill", action.elementId, action.value, ...target];
    case "type_text":
      return ["type", action.text, ...target, "--allow-hid"];
  }
};

const cliFailureMessage = (result: ComputerCommandResult) =>
  result.stderr.trim() || `stella-computer exited ${result.exitCode}.`;

const parseActionPayload = (
  result: ComputerCommandResult,
): { payload?: JsonObject; error?: string } => {
  let payload: unknown;
  try {
    payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    return {
      error: `stella-computer returned invalid JSON: ${result.stdout.trim() || result.stderr.trim()}`,
    };
  }
  if (result.exitCode !== 0) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : cliFailureMessage(result);
    return { error: message };
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { error: "stella-computer returned an invalid action payload." };
  }
  try {
    assertJsonSafe(payload, "stella-computer action payload");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { payload: payload as JsonObject };
};

const receiptFor = (
  command: ComputerUseActionCommand,
  payload: JsonObject,
): ComputerUseActionReceipt => {
  const rawReceipt = payload.receipt;
  const receiptRecord =
    rawReceipt !== null &&
    typeof rawReceipt === "object" &&
    !Array.isArray(rawReceipt)
      ? (rawReceipt as Readonly<Record<string, unknown>>)
      : undefined;
  const receiptDeferred =
    receiptRecord && typeof receiptRecord.deferred === "boolean"
      ? receiptRecord.deferred
      : undefined;
  const deferred =
    receiptDeferred ??
    (typeof payload.deferred === "boolean" ? payload.deferred : true);
  return {
    type: "action",
    action: command.action.type,
    target: command.target,
    status: deferred ? "accepted" : "completed",
    deferred,
    details: payload,
  };
};

const targetLabel = (target: ComputerUseTarget) =>
  target.type === "app"
    ? target.app
    : (target.app ?? `window-id:${target.windowId}`);

const extractStateOutput = (stdout: string) => {
  let screenshotPath: string | null = null;
  let instructions: string | undefined;
  let text = stdout.replace(ATTACH_IMAGE_RE, (marker) => {
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
  text = text.replace(APP_INSTRUCTIONS_RE, (_full, body: string) => {
    if (instructions === undefined && body.trim()) instructions = body.trim();
    return "";
  });
  return {
    text: text.trim(),
    instructions,
    screenshot: screenshotPath
      ? ({ type: "image", url: pathToFileURL(screenshotPath).href } as const)
      : null,
  };
};

export const createCliDiagnosticsComputerUseSession = (
  options: CliDiagnosticsComputerUseSessionOptions,
): ComputerUseSession => {
  if (!options || typeof options !== "object") {
    throw new TypeError("CLI diagnostics session options are required.");
  }
  if (typeof options.runner !== "function") {
    throw new TypeError("CLI diagnostics session runner must be a function.");
  }
  if (typeof options.cwd !== "string" || options.cwd.trim() === "") {
    throw new TypeError("CLI diagnostics session cwd is required.");
  }
  const cliPath =
    options.cliPath ??
    fileURLToPath(new URL("../cli/stella-computer.js", import.meta.url));
  const env =
    options.env ??
    (process.versions.electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env);

  const request: ComputerUseSession["request"] = async (
    typedRequest,
    requestOptions,
  ) => {
    assertComputerUseRequest(typedRequest);
    const run = async (args: string[]) =>
      await options.runner({
        command: process.execPath,
        args: [cliPath, "--session", typedRequest.sessionId, ...args],
        cwd: options.cwd,
        env,
        signal:
          requestOptions?.signal ?? options.getSignal?.() ?? options.signal,
        timeoutMs: options.commandTimeoutMs ?? 30_000,
        maxOutputBytes: options.maxOutputBytes,
      });

    if (typedRequest.type === "list_apps") {
      const result = await run(["list-apps"]);
      return result.exitCode === 0
        ? {
            ...responseEnvelope(typedRequest),
            type: "list_apps",
            text: result.stdout.trim(),
          }
        : errorResponse(
            typedRequest,
            "cli_command_failed",
            cliFailureMessage(result),
          );
    }
    if (typedRequest.type === "list_windows") {
      const result = await run(["list-windows"]);
      return result.exitCode === 0
        ? {
            ...responseEnvelope(typedRequest),
            type: "list_windows",
            text: result.stdout.trim(),
          }
        : errorResponse(
            typedRequest,
            "cli_command_failed",
            cliFailureMessage(result),
          );
    }
    if (typedRequest.type === "resolve_target") {
      const label = targetLabel(typedRequest.selector);
      return {
        ...responseEnvelope(typedRequest),
        type: "target_policy",
        policy: {
          bundleIdentifier: label,
          displayName: label,
          decision: "allowed",
          allowPersistentApproval: false,
          risk: "CLI diagnostics cannot canonicalize an application selector.",
        },
      };
    }
    if (typedRequest.type === "get_app_state") {
      const result = await run([
        "get-state",
        ...targetArgs(typedRequest.target),
        "--no-inline-screenshot",
        "--screenshot-policy",
        typedRequest.screenshotPolicy,
        ...(typedRequest.disableDiff ? ["--disable-diff"] : []),
      ]);
      if (result.exitCode !== 0) {
        return errorResponse(
          typedRequest,
          "cli_command_failed",
          cliFailureMessage(result),
        );
      }
      return {
        ...responseEnvelope(typedRequest),
        type: "app_state",
        state: {
          app: targetLabel(typedRequest.target),
          ...extractStateOutput(result.stdout),
        },
      };
    }

    const executeAction = async (
      command: ComputerUseActionCommand,
    ): Promise<
      ComputerUseActionReceipt | Extract<ComputerUseResponse, { type: "error" }>
    > => {
      const result = await run([
        ...encodeAction(command),
        "--defer-observation",
        "--json",
      ]);
      const parsed = parseActionPayload(result);
      return parsed.error || !parsed.payload
        ? errorResponse(
            typedRequest,
            result.exitCode === 0
              ? "cli_invalid_response"
              : "cli_command_failed",
            parsed.error ?? cliFailureMessage(result),
          )
        : receiptFor(command, parsed.payload);
    };

    if (typedRequest.type === "action") {
      const receipt = await executeAction(typedRequest.command);
      return receipt.type === "error"
        ? receipt
        : {
            ...responseEnvelope(typedRequest),
            type: "action",
            receipt,
          };
    }

    const receipts: ComputerUseActionReceipt[] = [];
    for (const command of typedRequest.commands) {
      const receipt = await executeAction(command);
      if (receipt.type === "error") return receipt;
      receipts.push(receipt);
    }
    return {
      ...responseEnvelope(typedRequest),
      type: "batch",
      receipt: { type: "batch", receipts },
    };
  };

  return Object.freeze({ request });
};
