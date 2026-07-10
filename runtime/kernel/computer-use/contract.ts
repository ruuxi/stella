export const COMPUTER_USE_SCHEMA_VERSION = 1 as const;
export const COMPUTER_USE_PROTOCOL_VERSION = "1.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type ComputerUseTarget =
  | Readonly<{ type: "app"; app: string }>
  | Readonly<{ type: "window"; windowId: string; app?: string }>;

export type ComputerUseAppSelector = ComputerUseTarget;

export type ComputerUseAppPolicy = Readonly<{
  bundleIdentifier: string;
  displayName: string;
  appPath?: string;
  decision: "allowed" | "denied" | "forbidden";
  allowPersistentApproval: boolean;
  risk?: string;
  warningSubtitle?: string;
}>;

export type ComputerUsePoint = Readonly<{ x: number; y: number }>;
export type ComputerUseMouseButton = "left" | "right" | "middle";
export type ComputerUseScrollDirection = "up" | "down" | "left" | "right";
export type ComputerUseSelectionType =
  | "text"
  | "cursor-before"
  | "cursor-after";

export type ComputerUseAction =
  | Readonly<{
      type: "click_element";
      elementId: string;
      mouseButton: ComputerUseMouseButton;
      clickCount: number;
    }>
  | Readonly<{
      type: "click_point";
      point: ComputerUsePoint;
      mouseButton: ComputerUseMouseButton;
      clickCount: number;
    }>
  | Readonly<{
      type: "drag";
      from: ComputerUsePoint;
      to: ComputerUsePoint;
    }>
  | Readonly<{
      type: "perform_secondary_action";
      elementId: string;
      action: string;
    }>
  | Readonly<{ type: "press_key"; key: string }>
  | Readonly<{
      type: "scroll";
      elementId: string;
      direction: ComputerUseScrollDirection;
      pages: number;
    }>
  | Readonly<{
      type: "select_text";
      elementId: string;
      text: string;
      prefix?: string;
      suffix?: string;
      selectionType?: ComputerUseSelectionType;
    }>
  | Readonly<{ type: "set_value"; elementId: string; value: string }>
  | Readonly<{ type: "type_text"; text: string }>;

export type ComputerUseActionCommand = Readonly<{
  target: ComputerUseTarget;
  action: ComputerUseAction;
}>;

type ComputerUseRequestEnvelope = Readonly<{
  schemaVersion: typeof COMPUTER_USE_SCHEMA_VERSION;
  protocolVersion: typeof COMPUTER_USE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
}>;

export type ComputerUseRequest =
  | (ComputerUseRequestEnvelope & Readonly<{ type: "list_apps" }>)
  | (ComputerUseRequestEnvelope & Readonly<{ type: "list_windows" }>)
  | (ComputerUseRequestEnvelope &
      Readonly<{
        type: "resolve_target";
        selector: ComputerUseAppSelector;
      }>)
  | (ComputerUseRequestEnvelope &
      Readonly<{
        type: "get_app_state";
        target: ComputerUseTarget;
        screenshotPolicy: "auto" | "always" | "never";
        disableDiff: boolean;
      }>)
  | (ComputerUseRequestEnvelope &
      Readonly<{
        type: "action";
        execution: "background";
        command: ComputerUseActionCommand;
      }>)
  | (ComputerUseRequestEnvelope &
      Readonly<{
        type: "batch";
        execution: "background";
        commands: readonly ComputerUseActionCommand[];
      }>);

export type ComputerUseActionReceipt = Readonly<{
  type: "action";
  action: ComputerUseAction["type"];
  target: ComputerUseTarget;
  status: "accepted" | "completed";
  deferred: boolean;
  details?: JsonObject;
}>;

export type ComputerUseBatchReceipt = Readonly<{
  type: "batch";
  receipts: readonly ComputerUseActionReceipt[];
}>;

export type ComputerUseReceipt =
  | ComputerUseActionReceipt
  | ComputerUseBatchReceipt;

export type ComputerUseImage = Readonly<{
  type: "image";
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
}>;

export type ComputerUseAppState = Readonly<{
  app: string;
  text: string;
  screenshot: ComputerUseImage | null;
  instructions?: string;
}>;

type ComputerUseResponseEnvelope = Readonly<{
  schemaVersion: typeof COMPUTER_USE_SCHEMA_VERSION;
  protocolVersion: typeof COMPUTER_USE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
}>;

export type ComputerUseResponse =
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "list_apps"; text: string }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "list_windows"; text: string }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "target_policy"; policy: ComputerUseAppPolicy }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "app_state"; state: ComputerUseAppState }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "action"; receipt: ComputerUseActionReceipt }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{ type: "batch"; receipt: ComputerUseBatchReceipt }>)
  | (ComputerUseResponseEnvelope &
      Readonly<{
        type: "error";
        error: Readonly<{
          code: string;
          message: string;
          retryable?: boolean;
          details?: JsonObject;
        }>;
      }>);

export type ComputerUseResponseFor<TRequest extends ComputerUseRequest> =
  | Extract<ComputerUseResponse, { type: "error" }>
  | (TRequest["type"] extends "get_app_state"
      ? Extract<ComputerUseResponse, { type: "app_state" }>
      : TRequest["type"] extends "resolve_target"
        ? Extract<ComputerUseResponse, { type: "target_policy" }>
        : Extract<ComputerUseResponse, { type: TRequest["type"] }>);

type UnknownRecord = Record<string, unknown>;

const isRecord: (value: unknown) => value is UnknownRecord = (
  value,
): value is UnknownRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const fail: (context: string, message: string) => never = (
  context,
  message,
) => {
  throw new TypeError(`${context} ${message}`);
};

const record: (value: unknown, context: string) => UnknownRecord = (
  value,
  context,
) => {
  if (!isRecord(value)) fail(context, "must be a plain object.");
  return value;
};

const exactKeys = (
  value: UnknownRecord,
  allowed: readonly string[],
  context: string,
) => {
  const allowedSet = new Set(allowed);
  const unknownKey = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknownKey) fail(context, `contains unsupported field ${unknownKey}.`);
};

const nonEmptyString: (value: unknown, context: string) => string = (
  value,
  context,
) => {
  if (typeof value !== "string" || value.trim() === "") {
    fail(context, "must be a non-empty string.");
  }
  return value;
};

const stringValue: (value: unknown, context: string) => string = (
  value,
  context,
) => {
  if (typeof value !== "string") fail(context, "must be a string.");
  return value;
};

const finiteNumber: (value: unknown, context: string) => number = (
  value,
  context,
) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(context, "must be a finite number.");
  }
  return value;
};

const positiveInteger: (value: unknown, context: string) => number = (
  value,
  context,
) => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    fail(context, "must be a positive integer.");
  }
  return Number(value);
};

const booleanValue: (value: unknown, context: string) => boolean = (
  value,
  context,
) => {
  if (typeof value !== "boolean") fail(context, "must be a boolean.");
  return value;
};

const literal = <T extends string | number>(
  value: unknown,
  expected: T,
  context: string,
): T => {
  if (value !== expected) fail(context, `must be ${JSON.stringify(expected)}.`);
  return expected;
};

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(context, `must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
};

export const assertJsonSafe: (
  value: unknown,
  context?: string,
) => asserts value is JsonValue = (value, context = "value") => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(context, "contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonSafe(entry, `${context}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonSafe(entry, `${context}.${key}`);
    }
    return;
  }
  fail(context, "is not JSON-safe.");
};

const assertPoint = (value: unknown, context: string) => {
  const candidate = record(value, context);
  exactKeys(candidate, ["x", "y"], context);
  finiteNumber(candidate.x, `${context}.x`);
  finiteNumber(candidate.y, `${context}.y`);
};

export const assertComputerUseTarget: (
  value: unknown,
  context?: string,
) => asserts value is ComputerUseTarget = (value, context = "target") => {
  const candidate = record(value, context);
  if (candidate.type === "app") {
    exactKeys(candidate, ["type", "app"], context);
    nonEmptyString(candidate.app, `${context}.app`);
    return;
  }
  if (candidate.type === "window") {
    exactKeys(candidate, ["type", "windowId", "app"], context);
    nonEmptyString(candidate.windowId, `${context}.windowId`);
    if (candidate.app !== undefined) {
      nonEmptyString(candidate.app, `${context}.app`);
    }
    return;
  }
  fail(`${context}.type`, "must be app or window.");
};

export const assertComputerUseAction: (
  value: unknown,
  context?: string,
) => asserts value is ComputerUseAction = (value, context = "action") => {
  const candidate = record(value, context);
  switch (candidate.type) {
    case "click_element":
      exactKeys(
        candidate,
        ["type", "elementId", "mouseButton", "clickCount"],
        context,
      );
      nonEmptyString(candidate.elementId, `${context}.elementId`);
      oneOf(
        candidate.mouseButton,
        ["left", "right", "middle"],
        `${context}.mouseButton`,
      );
      positiveInteger(candidate.clickCount, `${context}.clickCount`);
      return;
    case "click_point":
      exactKeys(
        candidate,
        ["type", "point", "mouseButton", "clickCount"],
        context,
      );
      assertPoint(candidate.point, `${context}.point`);
      oneOf(
        candidate.mouseButton,
        ["left", "right", "middle"],
        `${context}.mouseButton`,
      );
      positiveInteger(candidate.clickCount, `${context}.clickCount`);
      return;
    case "drag":
      exactKeys(candidate, ["type", "from", "to"], context);
      assertPoint(candidate.from, `${context}.from`);
      assertPoint(candidate.to, `${context}.to`);
      return;
    case "perform_secondary_action":
      exactKeys(candidate, ["type", "elementId", "action"], context);
      nonEmptyString(candidate.elementId, `${context}.elementId`);
      nonEmptyString(candidate.action, `${context}.action`);
      return;
    case "press_key":
      exactKeys(candidate, ["type", "key"], context);
      nonEmptyString(candidate.key, `${context}.key`);
      return;
    case "scroll":
      exactKeys(
        candidate,
        ["type", "elementId", "direction", "pages"],
        context,
      );
      nonEmptyString(candidate.elementId, `${context}.elementId`);
      oneOf(
        candidate.direction,
        ["up", "down", "left", "right"],
        `${context}.direction`,
      );
      positiveInteger(candidate.pages, `${context}.pages`);
      return;
    case "select_text":
      exactKeys(
        candidate,
        ["type", "elementId", "text", "prefix", "suffix", "selectionType"],
        context,
      );
      nonEmptyString(candidate.elementId, `${context}.elementId`);
      nonEmptyString(candidate.text, `${context}.text`);
      if (candidate.prefix !== undefined) {
        stringValue(candidate.prefix, `${context}.prefix`);
      }
      if (candidate.suffix !== undefined) {
        stringValue(candidate.suffix, `${context}.suffix`);
      }
      if (candidate.selectionType !== undefined) {
        oneOf(
          candidate.selectionType,
          ["text", "cursor-before", "cursor-after"],
          `${context}.selectionType`,
        );
      }
      return;
    case "set_value":
      exactKeys(candidate, ["type", "elementId", "value"], context);
      nonEmptyString(candidate.elementId, `${context}.elementId`);
      stringValue(candidate.value, `${context}.value`);
      return;
    case "type_text":
      exactKeys(candidate, ["type", "text"], context);
      nonEmptyString(candidate.text, `${context}.text`);
      return;
    default:
      fail(`${context}.type`, "is not a supported computer-use action.");
  }
};

const assertActionCommand = (value: unknown, context: string) => {
  const candidate = record(value, context);
  exactKeys(candidate, ["target", "action"], context);
  assertComputerUseTarget(candidate.target, `${context}.target`);
  assertComputerUseAction(candidate.action, `${context}.action`);
};

const assertEnvelope = (candidate: UnknownRecord, context: string) => {
  literal(
    candidate.schemaVersion,
    COMPUTER_USE_SCHEMA_VERSION,
    `${context}.schemaVersion`,
  );
  literal(
    candidate.protocolVersion,
    COMPUTER_USE_PROTOCOL_VERSION,
    `${context}.protocolVersion`,
  );
  nonEmptyString(candidate.requestId, `${context}.requestId`);
  nonEmptyString(candidate.sessionId, `${context}.sessionId`);
};

const REQUEST_ENVELOPE_KEYS = [
  "schemaVersion",
  "protocolVersion",
  "requestId",
  "sessionId",
  "type",
] as const;

export const assertComputerUseRequest: (
  value: unknown,
) => asserts value is ComputerUseRequest = (value) => {
  assertJsonSafe(value, "ComputerUseRequest");
  const candidate = record(value, "ComputerUseRequest");
  assertEnvelope(candidate, "ComputerUseRequest");
  switch (candidate.type) {
    case "list_apps":
    case "list_windows":
      exactKeys(candidate, REQUEST_ENVELOPE_KEYS, "ComputerUseRequest");
      return;
    case "resolve_target":
      exactKeys(
        candidate,
        [...REQUEST_ENVELOPE_KEYS, "selector"],
        "ComputerUseRequest",
      );
      assertComputerUseTarget(
        candidate.selector,
        "ComputerUseRequest.selector",
      );
      return;
    case "get_app_state":
      exactKeys(
        candidate,
        [...REQUEST_ENVELOPE_KEYS, "target", "screenshotPolicy", "disableDiff"],
        "ComputerUseRequest",
      );
      assertComputerUseTarget(candidate.target, "ComputerUseRequest.target");
      oneOf(
        candidate.screenshotPolicy,
        ["auto", "always", "never"],
        "ComputerUseRequest.screenshotPolicy",
      );
      booleanValue(candidate.disableDiff, "ComputerUseRequest.disableDiff");
      return;
    case "action":
      exactKeys(
        candidate,
        [...REQUEST_ENVELOPE_KEYS, "execution", "command"],
        "ComputerUseRequest",
      );
      literal(
        candidate.execution,
        "background",
        "ComputerUseRequest.execution",
      );
      assertActionCommand(candidate.command, "ComputerUseRequest.command");
      return;
    case "batch":
      exactKeys(
        candidate,
        [...REQUEST_ENVELOPE_KEYS, "execution", "commands"],
        "ComputerUseRequest",
      );
      literal(
        candidate.execution,
        "background",
        "ComputerUseRequest.execution",
      );
      if (!Array.isArray(candidate.commands)) {
        fail("ComputerUseRequest.commands", "must be an array.");
      }
      candidate.commands.forEach((command, index) =>
        assertActionCommand(command, `ComputerUseRequest.commands[${index}]`),
      );
      return;
    default:
      fail("ComputerUseRequest.type", "is not supported.");
  }
};

const assertImage = (value: unknown, context: string) => {
  const candidate = record(value, context);
  exactKeys(candidate, ["type", "url", "mimeType", "width", "height"], context);
  literal(candidate.type, "image", `${context}.type`);
  nonEmptyString(candidate.url, `${context}.url`);
  if (candidate.mimeType !== undefined) {
    nonEmptyString(candidate.mimeType, `${context}.mimeType`);
  }
  if (candidate.width !== undefined) {
    positiveInteger(candidate.width, `${context}.width`);
  }
  if (candidate.height !== undefined) {
    positiveInteger(candidate.height, `${context}.height`);
  }
};

const assertAppState = (value: unknown, context: string) => {
  const candidate = record(value, context);
  exactKeys(candidate, ["app", "text", "screenshot", "instructions"], context);
  nonEmptyString(candidate.app, `${context}.app`);
  stringValue(candidate.text, `${context}.text`);
  if (candidate.screenshot !== null) {
    assertImage(candidate.screenshot, `${context}.screenshot`);
  }
  if (candidate.instructions !== undefined) {
    nonEmptyString(candidate.instructions, `${context}.instructions`);
  }
};

const assertAppPolicy = (value: unknown, context: string) => {
  const candidate = record(value, context);
  exactKeys(
    candidate,
    [
      "bundleIdentifier",
      "displayName",
      "appPath",
      "decision",
      "allowPersistentApproval",
      "risk",
      "warningSubtitle",
    ],
    context,
  );
  nonEmptyString(candidate.bundleIdentifier, `${context}.bundleIdentifier`);
  nonEmptyString(candidate.displayName, `${context}.displayName`);
  if (candidate.appPath !== undefined) {
    nonEmptyString(candidate.appPath, `${context}.appPath`);
  }
  oneOf(
    candidate.decision,
    ["allowed", "denied", "forbidden"],
    `${context}.decision`,
  );
  booleanValue(
    candidate.allowPersistentApproval,
    `${context}.allowPersistentApproval`,
  );
  if (candidate.risk !== undefined) {
    nonEmptyString(candidate.risk, `${context}.risk`);
  }
  if (candidate.warningSubtitle !== undefined) {
    nonEmptyString(candidate.warningSubtitle, `${context}.warningSubtitle`);
  }
};

const ACTION_TYPES: readonly ComputerUseAction["type"][] = [
  "click_element",
  "click_point",
  "drag",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
];

export const assertComputerUseReceipt: (
  value: unknown,
  context?: string,
) => asserts value is ComputerUseReceipt = (value, context = "receipt") => {
  const candidate = record(value, context);
  if (candidate.type === "action") {
    exactKeys(
      candidate,
      ["type", "action", "target", "status", "deferred", "details"],
      context,
    );
    oneOf(candidate.action, ACTION_TYPES, `${context}.action`);
    assertComputerUseTarget(candidate.target, `${context}.target`);
    oneOf(candidate.status, ["accepted", "completed"], `${context}.status`);
    booleanValue(candidate.deferred, `${context}.deferred`);
    if (candidate.details !== undefined) {
      record(candidate.details, `${context}.details`);
      assertJsonSafe(candidate.details, `${context}.details`);
    }
    return;
  }
  if (candidate.type === "batch") {
    exactKeys(candidate, ["type", "receipts"], context);
    if (!Array.isArray(candidate.receipts)) {
      fail(`${context}.receipts`, "must be an array.");
    }
    candidate.receipts.forEach((receipt, index) => {
      assertComputerUseReceipt(receipt, `${context}.receipts[${index}]`);
      if (receipt.type !== "action") {
        fail(`${context}.receipts[${index}]`, "must be an action receipt.");
      }
    });
    return;
  }
  fail(`${context}.type`, "must be action or batch.");
};

const RESPONSE_ENVELOPE_KEYS = REQUEST_ENVELOPE_KEYS;

export const assertComputerUseResponse: (
  value: unknown,
) => asserts value is ComputerUseResponse = (value) => {
  assertJsonSafe(value, "ComputerUseResponse");
  const candidate = record(value, "ComputerUseResponse");
  assertEnvelope(candidate, "ComputerUseResponse");
  switch (candidate.type) {
    case "list_apps":
    case "list_windows":
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "text"],
        "ComputerUseResponse",
      );
      stringValue(candidate.text, "ComputerUseResponse.text");
      return;
    case "target_policy":
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "policy"],
        "ComputerUseResponse",
      );
      assertAppPolicy(candidate.policy, "ComputerUseResponse.policy");
      return;
    case "app_state":
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "state"],
        "ComputerUseResponse",
      );
      assertAppState(candidate.state, "ComputerUseResponse.state");
      return;
    case "action":
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "receipt"],
        "ComputerUseResponse",
      );
      assertComputerUseReceipt(
        candidate.receipt,
        "ComputerUseResponse.receipt",
      );
      if (candidate.receipt.type !== "action") {
        fail("ComputerUseResponse.receipt", "must be an action receipt.");
      }
      return;
    case "batch":
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "receipt"],
        "ComputerUseResponse",
      );
      assertComputerUseReceipt(
        candidate.receipt,
        "ComputerUseResponse.receipt",
      );
      if (candidate.receipt.type !== "batch") {
        fail("ComputerUseResponse.receipt", "must be a batch receipt.");
      }
      return;
    case "error": {
      exactKeys(
        candidate,
        [...RESPONSE_ENVELOPE_KEYS, "error"],
        "ComputerUseResponse",
      );
      const error = record(candidate.error, "ComputerUseResponse.error");
      exactKeys(
        error,
        ["code", "message", "retryable", "details"],
        "ComputerUseResponse.error",
      );
      nonEmptyString(error.code, "ComputerUseResponse.error.code");
      nonEmptyString(error.message, "ComputerUseResponse.error.message");
      if (error.retryable !== undefined) {
        booleanValue(error.retryable, "ComputerUseResponse.error.retryable");
      }
      if (error.details !== undefined) {
        record(error.details, "ComputerUseResponse.error.details");
        assertJsonSafe(error.details, "ComputerUseResponse.error.details");
      }
      return;
    }
    default:
      fail("ComputerUseResponse.type", "is not supported.");
  }
};

export const parseComputerUseRequest = (value: unknown): ComputerUseRequest => {
  assertComputerUseRequest(value);
  return value;
};

export const parseComputerUseResponse = (
  value: unknown,
): ComputerUseResponse => {
  assertComputerUseResponse(value);
  return value;
};
