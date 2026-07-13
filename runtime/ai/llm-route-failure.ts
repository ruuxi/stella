/**
 * Shared (browser-safe) vocabulary for "couldn't resolve an LLM route".
 *
 * The runtime route resolver (runtime/kernel/model-routing.ts) builds these
 * failures and throws `formatLlmRouteFailure(...)`. The desktop toast resolver
 * (desktop/src/features/chat/streaming/stella-provider-error-toast.ts) maps the
 * thrown message back to an actionable toast via `detectLlmRouteFailureKind`.
 *
 * The two ends are linked by the stable `kind` markers embedded in the
 * message — NEVER by matching human-readable prose. Reworded or translated copy
 * therefore can't silently drop the specific error handling. The
 * `formatLlmRouteFailure`/`detectLlmRouteFailureKind` round-trip is covered by a
 * test so the contract can't drift.
 */
import { getProviderDisplayName } from "./provider-display.js";

export type LlmRouteFailure =
  | { kind: "unsupported-provider"; provider: string; model: string }
  | {
      kind: "unknown-model";
      provider: string;
      model: string;
      suggestedModel?: string;
    }
  | { kind: "missing-credential"; provider: string; model: string }
  | { kind: "no-stella-route" };

export type LlmRouteFailureKind = LlmRouteFailure["kind"];

/**
 * Stable, machine-readable markers appended to thrown route-failure messages.
 * UI matches on these tokens, not the surrounding prose.
 */
export const LLM_ROUTE_FAILURE_MARKERS: Record<LlmRouteFailureKind, string> = {
  "unsupported-provider": "stella.route_error.unsupported_provider",
  "unknown-model": "stella.route_error.unknown_model",
  "missing-credential": "stella.route_error.missing_credential",
  "no-stella-route": "stella.route_error.no_stella_route",
};

const markerSuffix = (kind: LlmRouteFailureKind): string =>
  ` [${LLM_ROUTE_FAILURE_MARKERS[kind]}]`;

/**
 * Render a route failure into a user-facing message with a trailing stable
 * marker. The prose is for humans and logs; the marker is the contract the UI
 * matches on.
 */
export const formatLlmRouteFailure = (failure: LlmRouteFailure): string => {
  switch (failure.kind) {
    case "missing-credential": {
      const name = getProviderDisplayName(failure.provider);
      return `No usable API key for ${name} (selected model "${failure.model}"). Add or re-check your ${name} key in Settings → Model, or pick another model.${markerSuffix(failure.kind)}`;
    }
    case "unknown-model": {
      if (!failure.suggestedModel) {
        return `Selected model "${failure.model}" is not available from ${getProviderDisplayName(failure.provider)}. Pick a different model in Settings → Model.${markerSuffix(failure.kind)}`;
      }
      const engineName = failure.suggestedModel.startsWith("codex/")
        ? "the Codex engine"
        : failure.suggestedModel.startsWith("claude-code/")
          ? "the Claude Code engine"
          : "another engine";
      return `Selected model "${failure.model}" is not available from ${getProviderDisplayName(failure.provider)}. It is served by ${engineName}; use "${failure.suggestedModel}" instead.${markerSuffix(failure.kind)}`;
    }
    case "unsupported-provider":
      return `Unknown model provider "${failure.provider}" (selected model "${failure.model}"). Pick a different model in Settings → Model.${markerSuffix(failure.kind)}`;
    case "no-stella-route":
      return `No usable model route is configured. Sign in to use Stella, or add a provider API key in Settings.${markerSuffix(failure.kind)}`;
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
};

/**
 * Recover the failure kind from a thrown message via its stable marker.
 * Returns null when the message isn't a recognized route failure.
 */
export const detectLlmRouteFailureKind = (
  message: string | null | undefined,
): LlmRouteFailureKind | null => {
  if (!message) return null;
  for (const kind of Object.keys(
    LLM_ROUTE_FAILURE_MARKERS,
  ) as LlmRouteFailureKind[]) {
    if (message.includes(LLM_ROUTE_FAILURE_MARKERS[kind])) {
      return kind;
    }
  }
  return null;
};
