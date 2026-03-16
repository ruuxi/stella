type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]key)/i;

const sanitizeLogValue = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[REDACTED]"
      : sanitizeLogValue(entry, depth + 1, seen);
  }
  return output;
};

const parseDebugScopes = (): string[] =>
  (process.env.STELLA_RUNTIME_DEBUG ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

const shouldEmitDebug = (scope: string): boolean => {
  const selectors = parseDebugScopes();
  if (selectors.length === 0) {
    return false;
  }
  if (selectors.includes("*") || selectors.includes("1") || selectors.includes("true")) {
    return true;
  }
  return selectors.some((selector) => scope === selector || scope.startsWith(`${selector}.`));
};

const emitLog = (
  level: RuntimeLogLevel,
  scope: string,
  message: string,
  fields?: unknown,
): void => {
  if (level === "debug" && !shouldEmitDebug(scope)) {
    return;
  }

  const prefix = `[stella:${scope}]`;
  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  if (fields === undefined) {
    consoleMethod(`${prefix} ${message}`);
    return;
  }

  consoleMethod(`${prefix} ${message}`, sanitizeLogValue(fields));
};

export const createRuntimeLogger = (scope: string) => ({
  debug: (message: string, fields?: unknown) =>
    emitLog("debug", scope, message, fields),
  info: (message: string, fields?: unknown) =>
    emitLog("info", scope, message, fields),
  warn: (message: string, fields?: unknown) =>
    emitLog("warn", scope, message, fields),
  error: (message: string, fields?: unknown) =>
    emitLog("error", scope, message, fields),
});

