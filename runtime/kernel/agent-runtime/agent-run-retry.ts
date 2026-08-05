import { isTransientProviderStreamAnomalyMessage } from "../../ai/utils/provider-stop.js";

const isLocalContextPreflight = (message: string): boolean =>
  message.includes(
    "Context preflight context_length_exceeded before provider dispatch",
  );

export const AGENT_RUN_MAX_ATTEMPTS = 4;
export const AGENT_RUN_RETRY_DELAYS_MS = [1_000, 2_500, 6_000] as const;
export const AGENT_RUN_RETRY_JITTER_RATIO = 0.1;

export const EMPTY_AGENT_RUN_ERROR =
  "The model ended the turn without a user-visible reply.";

export type AgentRunFailureCategory =
  | "http_5xx"
  | "rate_limit"
  | "transport"
  | "empty_response"
  | "auth"
  | "invalid_model_or_route"
  | "canceled"
  | "non_retryable";

export type AgentRunFailure = {
  category: AgentRunFailureCategory;
  message: string;
  retryable: boolean;
};

export type AgentTurnExecution = {
  finalText: string;
  errorMessage?: string;
};

export type AgentRunRetryState = {
  attemptsUsed: number;
  retriesUsed: number;
};

export type AgentRunRetryInfo = AgentRunFailure & {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
};

export const formatAgentRunRetryStatus = (info: AgentRunRetryInfo): string => {
  const seconds = Math.max(0.1, info.delayMs / 1_000);
  const formattedSeconds = Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(1).replace(/\.0$/, "");
  return `Connection interrupted. Retrying in ${formattedSeconds}s (attempt ${info.attempt} of ${info.maxAttempts})`;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const numericStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
};

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toUpperCase() : undefined;
};

const isExplicitCancellation = (message: string): boolean =>
  /\b(?:aborted by (?:the )?user|explicit(?:ly)? cancel(?:ed|led)|cancel(?:ed|led) by (?:the )?user|user cancel(?:ed|led))\b/i.test(
    message,
  );

const isAuthFailure = (message: string, status?: number): boolean =>
  status === 401 ||
  status === 403 ||
  /\b(?:http(?: status)?\s*[:=]?\s*)?(?:401|403)\b|\b(?:unauthorized|forbidden|authentication(?: failed| error)|authenticationerror|invalid api key|invalid_api_key|missing api key|permission denied)\b/i.test(
    message,
  );

const isInvalidModelOrRoute = (message: string): boolean =>
  /\b(?:invalid|unknown|unsupported|unrecognized)\s+(?:model|route)\b|\b(?:model|route)[-_ ]not[-_ ]found\b|\bno (?:valid )?(?:model|route)\b|\b(?:model|route)\s+[^\n]{0,100}\s+not found\b/i.test(
    message,
  );

const isRateLimit = (message: string, status?: number): boolean =>
  status === 429 ||
  /\b(?:http(?: status)?\s*[:=]?\s*)?429\b|\btoo many requests\b|\brate limit(?:ed|ing)?\b/i.test(
    message,
  );

const isHttp5xx = (message: string, status?: number): boolean =>
  (typeof status === "number" && status >= 500 && status <= 599) ||
  /(?:^|\b)(?:http(?: status)?|status(?: code)?|upstream)\s*[:=]?\s*5\d\d\b|(?:^|\b)5\d\d\s+server error\b|\bserver error\s*[:=]?\s*5\d\d\b|\b(?:server_error|internal_server_error|service_unavailable_error|server_is_overloaded)\b/i.test(
    message,
  );

const TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
]);

const isTransportFailure = (message: string, code?: string): boolean =>
  (code !== undefined && TRANSPORT_CODES.has(code)) ||
  /\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|ENOTFOUND|UND_ERR_SOCKET)\b|\bunexpected eof\b|\bpremature (?:stream )?close\b|\bconnection (?:reset|refused|closed|terminated|timed? out)\b|\bsocket (?:hang up|closed|reset|terminated)\b|\bfetch failed\b|\bfailed to fetch\b|\bnetwork[_ ](?:error|offline)\b|\btransport (?:error|eof|timeout)\b|\btimed? out\b|\btimeout\b|\bdid not produce activity for \d+(?:\.\d+)?s\b/i.test(
    message,
  );

export const classifyAgentRunFailure = (
  error: unknown,
  options?: { signal?: AbortSignal },
): AgentRunFailure => {
  const message = errorMessage(error).trim() || "Agent run failed";
  const status = numericStatus(error);
  const code = errorCode(error);

  if (options?.signal?.aborted || isExplicitCancellation(message)) {
    return { category: "canceled", message, retryable: false };
  }
  if (isAuthFailure(message, status)) {
    return { category: "auth", message, retryable: false };
  }
  if (isInvalidModelOrRoute(message)) {
    return { category: "invalid_model_or_route", message, retryable: false };
  }
  if (/run truncated:[^\n]*no visible reply was produced/i.test(message)) {
    return { category: "empty_response", message, retryable: true };
  }
  if (isRateLimit(message, status)) {
    return { category: "rate_limit", message, retryable: true };
  }
  if (isHttp5xx(message, status)) {
    return { category: "http_5xx", message, retryable: true };
  }
  // Provider stream anomalies with transient fingerprints (premature EOF
  // before a terminal event, neutral non-safety abnormal stops, pause_turn)
  // are transport-class: the remedy is resubmitting the request. Safety /
  // prompt-block wordings deliberately do not match — those are deterministic
  // content aborts owned by provider-abort containment.
  if (
    isTransportFailure(message, code) ||
    isTransientProviderStreamAnomalyMessage(message)
  ) {
    return { category: "transport", message, retryable: true };
  }
  return { category: "non_retryable", message, retryable: false };
};

const classifyExecution = (
  execution: AgentTurnExecution,
  signal?: AbortSignal,
): AgentRunFailure | null => {
  if (execution.errorMessage?.trim()) {
    return classifyAgentRunFailure(execution.errorMessage, { signal });
  }
  if (!execution.finalText.trim()) {
    return {
      category: "empty_response",
      message: EMPTY_AGENT_RUN_ERROR,
      retryable: true,
    };
  }
  return null;
};

export const agentRunRetryDelayMs = (
  retryIndex: number,
  random: () => number = Math.random,
): number => {
  const base =
    AGENT_RUN_RETRY_DELAYS_MS[
      Math.min(Math.max(0, retryIndex), AGENT_RUN_RETRY_DELAYS_MS.length - 1)
    ];
  const jitter = 1 + (random() * 2 - 1) * AGENT_RUN_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(base * jitter));
};

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Request was aborted",
  );
  error.name = "AbortError";
  return error;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const exhaustedMessage = (failure: AgentRunFailure, attempts: number): string =>
  `Automatic recovery exhausted after ${attempts} attempts (${failure.category}): ${failure.message}`;

export const hasAgentRunAttemptBudget = (
  state: AgentRunRetryState,
  maxAttempts: number = AGENT_RUN_MAX_ATTEMPTS,
): boolean => state.attemptsUsed < Math.max(1, maxAttempts);

export const executeAgentTurnWithRetry = async (args: {
  state?: AgentRunRetryState;
  execute: (resume: boolean) => Promise<AgentTurnExecution>;
  initialResume?: boolean;
  prepareRetry: (failure: AgentRunFailure) => boolean;
  signal?: AbortSignal;
  onRetry?: (info: AgentRunRetryInfo) => void;
  maxAttempts?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<AgentTurnExecution & { attempts: number }> => {
  const maxAttempts = Math.max(1, args.maxAttempts ?? AGENT_RUN_MAX_ATTEMPTS);
  const wait = args.sleep ?? sleep;
  const state = args.state ?? { attemptsUsed: 0, retriesUsed: 0 };
  let resume = args.initialResume === true;

  for (;;) {
    if (args.signal?.aborted) throw abortError(args.signal);
    if (!hasAgentRunAttemptBudget(state, maxAttempts)) {
      throw new Error(
        `Agent run attempt budget exhausted after ${state.attemptsUsed} attempts`,
      );
    }
    state.attemptsUsed += 1;

    let execution: AgentTurnExecution;
    let thrownFailure: AgentRunFailure | undefined;
    try {
      execution = await args.execute(resume);
    } catch (error) {
      execution = { finalText: "", errorMessage: errorMessage(error) };
      thrownFailure = classifyAgentRunFailure(error, { signal: args.signal });
      if (thrownFailure.message !== execution.errorMessage) {
        execution.errorMessage = thrownFailure.message;
      }
    }

    const failure = thrownFailure ?? classifyExecution(execution, args.signal);
    if (!failure) return { ...execution, attempts: state.attemptsUsed };
    // This rejection is raised locally before a provider request is sent. The
    // outer context-overflow recovery loop owns compaction and resumption, so
    // it must not consume the provider/transient retry budget.
    if (isLocalContextPreflight(failure.message)) {
      state.attemptsUsed = Math.max(0, state.attemptsUsed - 1);
      return {
        finalText: execution.finalText,
        errorMessage: failure.message,
        attempts: state.attemptsUsed,
      };
    }
    if (!failure.retryable) {
      return {
        finalText: execution.finalText,
        errorMessage: failure.message,
        attempts: state.attemptsUsed,
      };
    }
    if (!hasAgentRunAttemptBudget(state, maxAttempts)) {
      return {
        finalText: execution.finalText,
        errorMessage: exhaustedMessage(failure, state.attemptsUsed),
        attempts: state.attemptsUsed,
      };
    }

    const delayMs = agentRunRetryDelayMs(state.retriesUsed, args.random);
    const nextAttempt = state.attemptsUsed + 1;
    state.retriesUsed += 1;
    try {
      args.onRetry?.({
        ...failure,
        attempt: nextAttempt,
        maxAttempts,
        delayMs,
      });
    } catch {
      // Activity/status reporting must never break recovery.
    }
    await wait(delayMs, args.signal);
    if (!args.prepareRetry(failure)) {
      return {
        finalText: execution.finalText,
        errorMessage: `Automatic recovery could not safely resume after attempt ${state.attemptsUsed} (${failure.category}): ${failure.message}`,
        attempts: state.attemptsUsed,
      };
    }
    resume = true;
  }
};
