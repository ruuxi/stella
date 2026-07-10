/**
 * Inline "connect the Stella browser extension" offer for `exec_command`.
 *
 * `stella-browser` needs the Chrome extension bridge. When a command fails
 * because the extension isn't installed/connected, the daemon prints a
 * well-known error ("Extension not connected. Install the Stella Browser
 * Bridge extension and connect it."). Instead of dead-ending the agent on
 * that string, the exec tool asks the desktop to render an inline connect
 * card in the chat (mirroring the connector connect card), waits for the
 * user to install/connect or decline, and re-runs the original command once
 * on success — so the agent that hit the failure just sees the retried
 * result and proceeds with its task.
 *
 * The whole path is best-effort and conservative:
 * - only completed (non-running) `stella-browser` commands are considered;
 *   the failure means the command never reached a browser, so a single
 *   re-run is safe;
 * - one offer at a time, with a decline cool-down so a burst of failing
 *   commands can't spam the user with cards;
 * - any bridge/host error falls back to returning the original result.
 */

import type { ToolResult } from "./types.js";

export type BrowserExtensionConnectOutcome =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

export type BrowserExtensionConnectRequester = (
  payload: {
    conversationId?: string;
    agentId?: string;
    /** The failing command, for context in logs — never rendered verbatim. */
    command?: string;
  },
  /**
   * Turn abort signal. The worker-side implementation cancels the
   * pending desktop card when it fires.
   */
  signal?: AbortSignal,
) => Promise<BrowserExtensionConnectOutcome>;

/**
 * Error strings printed by the stella-browser CLI/daemon when the Chrome
 * extension bridge has no extension client. See
 * `desktop/stella-browser/cli/src/native/extension_bridge.rs`.
 */
const EXTENSION_FAILURE_PATTERN =
  /Extension not connected|Install the Stella Browser Bridge extension/i;

/**
 * "Service worker terminated" has its own transient error + retry hint and
 * must NOT trigger an install offer — the extension is installed and will
 * self-reconnect.
 */
const TRANSIENT_EXTENSION_PATTERN =
  /Extension connection is dead|will auto-reconnect/i;

const STELLA_BROWSER_COMMAND_PATTERN = /(^|[\s;|&("'`])stella-browser(\s|$)/;

/** How long the exec tool is willing to sit on an open connect card. */
const OFFER_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** After a decline/timeout, don't re-offer for this long. */
const DECLINE_COOLDOWN_MS = 15 * 60 * 1000;

type OfferGateState = {
  /** Millis timestamp of the last decline/timeout outcome. */
  lastRefusedAt: number | null;
  /** An offer card is currently open. */
  inFlight: boolean;
};

const gate: OfferGateState = { lastRefusedAt: null, inFlight: false };

/** Test hook: reset the module-level offer gate. */
export const resetBrowserExtensionOfferGate = () => {
  gate.lastRefusedAt = null;
  gate.inFlight = false;
};

export const isBrowserExtensionFailure = (
  command: string,
  payload: { running?: unknown; output?: unknown } | undefined,
): boolean => {
  if (!payload || payload.running === true) return false;
  if (!STELLA_BROWSER_COMMAND_PATTERN.test(command)) return false;
  const output = typeof payload.output === "string" ? payload.output : "";
  if (!EXTENSION_FAILURE_PATTERN.test(output)) return false;
  if (TRANSIENT_EXTENSION_PATTERN.test(output)) return false;
  return true;
};

const execPayloadOf = (
  result: ToolResult,
):
  | (Record<string, unknown> & { running?: unknown; output?: unknown })
  | null => {
  const payload = result.result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
};

const annotate = (result: ToolResult, note: string): ToolResult => {
  const payload = execPayloadOf(result);
  if (!payload) return result;
  const annotated = { ...payload, note };
  return { ...result, result: annotated, details: annotated };
};

const withTimeout = async (
  promise: Promise<BrowserExtensionConnectOutcome>,
  timeoutMs: number,
): Promise<BrowserExtensionConnectOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<BrowserExtensionConnectOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Shared low-level offer path for direct browser transports that do not return
 * an exec_command-shaped ToolResult. Returns null when the failure is unrelated
 * to a missing extension and otherwise returns the connect-card outcome.
 */
export const maybeRequestBrowserExtensionConnect = async (options: {
  output: string;
  command?: string;
  requestConnect?: BrowserExtensionConnectRequester;
  conversationId?: string;
  agentId?: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<BrowserExtensionConnectOutcome | null> => {
  const command = options.command ?? "stella-browser";
  const now = options.now ?? Date.now;
  if (!options.requestConnect || options.signal?.aborted) return null;
  if (
    !isBrowserExtensionFailure(command, {
      running: false,
      output: options.output,
    })
  ) {
    return null;
  }
  if (gate.inFlight) return { ok: false, reason: "already_in_flight" };
  if (
    gate.lastRefusedAt !== null &&
    now() - gate.lastRefusedAt < DECLINE_COOLDOWN_MS
  ) {
    return { ok: false, reason: "cooldown" };
  }

  gate.inFlight = true;
  let outcome: BrowserExtensionConnectOutcome;
  try {
    outcome = await withTimeout(
      options.requestConnect(
        {
          ...(options.conversationId
            ? { conversationId: options.conversationId }
            : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
          command,
        },
        options.signal,
      ),
      OFFER_WAIT_TIMEOUT_MS,
    );
  } catch (error) {
    outcome = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    gate.inFlight = false;
  }
  if (
    !outcome.ok &&
    (outcome.reason === "declined" || outcome.reason === "timeout")
  ) {
    gate.lastRefusedAt = now();
  }
  return outcome;
};

/**
 * Wrap a completed `exec_command` result: when it is a stella-browser
 * extension-bridge failure, offer the inline connect card and re-run the
 * command once after the user connects. Returns either the (annotated)
 * original result or the retried result.
 */
export const maybeOfferBrowserExtensionConnect = async (options: {
  result: ToolResult;
  command: string;
  requestConnect?: BrowserExtensionConnectRequester;
  rerun: () => Promise<ToolResult>;
  conversationId?: string;
  agentId?: string;
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  now?: () => number;
}): Promise<ToolResult> => {
  const {
    result,
    command,
    requestConnect,
    rerun,
    conversationId,
    agentId,
    signal,
  } = options;
  const now = options.now ?? Date.now;
  if (!requestConnect) return result;
  if (signal?.aborted) return result;
  const payload = execPayloadOf(result);
  if (!payload || !isBrowserExtensionFailure(command, payload)) return result;

  if (gate.inFlight) {
    return annotate(
      result,
      "The Stella browser extension is not connected and a connect card is already open in the chat. Wait for the user's response before retrying stella-browser, or use a fallback (stella-computer GUI automation).",
    );
  }
  if (
    gate.lastRefusedAt !== null &&
    now() - gate.lastRefusedAt < DECLINE_COOLDOWN_MS
  ) {
    return annotate(
      result,
      "The Stella browser extension is not connected and the user recently declined (or ignored) the connect offer. Do not re-offer; continue with a fallback — stella-computer GUI automation on a visible browser window, or ask the user only if the task is impossible otherwise.",
    );
  }

  gate.inFlight = true;
  let outcome: BrowserExtensionConnectOutcome;
  try {
    outcome = await withTimeout(
      requestConnect(
        {
          ...(conversationId ? { conversationId } : {}),
          ...(agentId ? { agentId } : {}),
          command,
        },
        signal,
      ),
      OFFER_WAIT_TIMEOUT_MS,
    );
  } catch (error) {
    outcome = { ok: false, reason: (error as Error).message || "bridge_error" };
  } finally {
    gate.inFlight = false;
  }

  if (signal?.aborted) return result;

  if (!outcome.ok) {
    if (outcome.reason === "declined" || outcome.reason === "timeout") {
      gate.lastRefusedAt = now();
      return annotate(
        result,
        outcome.reason === "declined"
          ? "A connect card for the Stella browser extension was shown in the chat and the user declined. Acknowledge once at most (it stays available in the Store/settings), do not re-offer, and continue via a fallback — stella-computer GUI automation on a visible browser window."
          : "A connect card for the Stella browser extension was shown in the chat but the user did not respond in time. Do not re-offer; continue via a fallback (stella-computer GUI automation), or park the browser-dependent step.",
      );
    }
    // unsupported / bridge error: stay quiet, just return the raw failure.
    return result;
  }

  const retried = await rerun();
  if (isBrowserExtensionFailure(command, execPayloadOf(retried) ?? undefined)) {
    // The user accepted but the bridge still isn't up (extension disabled,
    // browser closed, install still settling). Don't loop offers.
    gate.lastRefusedAt = now();
    return annotate(
      retried,
      "The user accepted the browser-extension connect card, but the extension bridge still is not reachable (the browser may be closed or the extension disabled). Do not re-offer; continue via a fallback — stella-computer GUI automation — or briefly tell the user what is still missing.",
    );
  }
  return annotate(
    retried,
    "The user connected the Stella browser extension via the inline card and the failed command was re-run automatically above. Continue the original task.",
  );
};
