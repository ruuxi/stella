/**
 * `connector_status` — deterministic connector check + inline connect
 * card, for the orchestrator only.
 *
 * Deferred: it never sits in the always-loaded tool list. The
 * connector-availability system reminder tells the orchestrator to
 * surface it via `tool_search` ("connector status") when a user message
 * keyword-matches a non-connected connector.
 *
 * Calling it with a connector name/id is pure lookup + card trigger —
 * no LLM inside:
 *  - connected → reports that, nothing else happens;
 *  - previously declined → reports that with Store-later guidance, no card;
 *  - otherwise → shows the inline connect card (the same
 *    ConnectorConnectService flow the CLI path uses), blocks until the
 *    user resolves it, and reports the outcome. A decline is persisted
 *    so the offer is never repeated.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  resolveNativeConnectorCatalog,
  type NativeCatalogSource,
} from "../../connectors/catalog-cache.js";
import {
  getConnectorDecline,
  recordConnectorDecline,
} from "../../connectors/connect-preferences.js";
import { getNativeConnectorReadiness } from "../../connectors/connection-status.js";
import { scoreConnectorMatch } from "../../connectors/discovery.js";
import type { NativeConnectorCatalogEntry } from "../../connectors/native-integrations.js";
import type { ToolDefinition } from "../types.js";

export const CONNECTOR_STATUS_TOOL_NAME = "connector_status";

export type ConnectorConnectionRequester = (
  payload: {
    id: string;
    name: string;
    description?: string;
    iconUrl?: string;
    category?: string;
    reason?: string;
    /** Chat the card belongs to; the renderer scopes the card to it. */
    conversationId?: string;
  },
  /**
   * Turn abort signal. The worker-side implementation cancels the
   * pending desktop card when it fires, so a cancelled/superseded turn
   * doesn't leave a card up for the desktop's full timeout.
   */
  signal?: AbortSignal,
) => Promise<
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    }
>;

export type ConnectorStatusToolOptions = {
  /** `~/.stella` (durable state root — connector state + catalog cache). */
  stellaDataDir: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  /** Desktop hop that renders the inline connect card. */
  requestConnectorConnection?: ConnectorConnectionRequester;
  fetchImpl?: typeof fetch;
};

const SERVER_CATALOG_TTL_MS = 5 * 60 * 1000;

type CatalogMemo = {
  stellaDataDir: string;
  loadedAt: number;
  entries: NativeConnectorCatalogEntry[];
  source: NativeCatalogSource;
  sources: Record<string, NativeCatalogSource>;
};

let catalogMemo: CatalogMemo | null = null;

/** Test hook. */
export const resetConnectorStatusCatalogMemo = () => {
  catalogMemo = null;
};

const loadCatalog = async (
  options: ConnectorStatusToolOptions,
): Promise<{
  entries: NativeConnectorCatalogEntry[];
  source: NativeCatalogSource;
  sources: Record<string, NativeCatalogSource>;
}> => {
  if (
    catalogMemo &&
    catalogMemo.stellaDataDir === options.stellaDataDir &&
    Date.now() - catalogMemo.loadedAt < SERVER_CATALOG_TTL_MS
  ) {
    return {
      entries: catalogMemo.entries,
      source: catalogMemo.source,
      sources: catalogMemo.sources,
    };
  }
  const resolved = await resolveNativeConnectorCatalog(options);
  catalogMemo = {
    stellaDataDir: options.stellaDataDir,
    loadedAt: Date.now(),
    entries: resolved.entries,
    source: resolved.source,
    sources: resolved.sources,
  };
  return resolved;
};

const tokenize = (value: string): string[] => [
  ...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  ),
];

const resolveEntry = (
  catalog: readonly NativeConnectorCatalogEntry[],
  query: string,
): {
  entry: NativeConnectorCatalogEntry | null;
  suggestions: NativeConnectorCatalogEntry[];
} => {
  const normalized = query.trim().toLowerCase();
  const exact = catalog.find(
    (entry) =>
      entry.id === normalized || entry.name.trim().toLowerCase() === normalized,
  );
  if (exact) return { entry: exact, suggestions: [] };
  const tokens = tokenize(query);
  const ranked = catalog
    .map((entry) => ({ entry, score: scoreConnectorMatch(tokens, entry) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 0 && ranked[0]!.score >= 20) {
    return { entry: ranked[0]!.entry, suggestions: [] };
  }
  return {
    entry: null,
    suggestions: ranked.slice(0, 3).map(({ entry }) => entry),
  };
};

export const createConnectorStatusTool = (
  options: ConnectorStatusToolOptions,
): ToolDefinition => ({
  name: CONNECTOR_STATUS_TOOL_NAME,
  label: "Connector status",
  workingText: "Checking connector",
  // Orchestrator-only chat affordance, mirroring the map/html tools.
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  // Hidden from the initial catalog; the connector-availability reminder
  // points the orchestrator at tool_search("connector status").
  deferred: {
    searchTerms: [
      "connector",
      "connectors",
      "integration",
      "integrations",
      "connect",
      "connection",
      "status",
      "oauth",
      "account",
      "service",
      "store",
    ],
  },
  description:
    "Check whether a Stella Store connector (Gmail, Outlook, Notion, Slack, and hundreds more) is connected, and if not, show the user an inline connect card in the chat. Deterministic — pure lookup plus the card; the card itself is the user's consent, so don't ask permission before calling. Blocks until the user connects, declines, or the card times out, then reports the outcome so you can proceed.",
  parameters: {
    type: "object",
    properties: {
      connector: {
        type: "string",
        description:
          'Connector id or name (e.g. "gmail", "Google Calendar", "notion").',
      },
      reason: {
        type: "string",
        description:
          'Optional one-line, user-facing context shown on the card (e.g. "To check your recent purchase emails").',
      },
    },
    required: ["connector"],
    additionalProperties: false,
  },
  execute: async (args, context, extras) => {
    const query =
      typeof args.connector === "string" ? args.connector.trim() : "";
    if (!query) {
      return { error: "connector is required (id or name)." };
    }
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : undefined;

    const catalog = await loadCatalog(options);
    const { entry, suggestions } = resolveEntry(catalog.entries, query);
    if (!entry) {
      const hint =
        suggestions.length > 0
          ? ` Closest matches: ${suggestions
              .map((candidate) => `${candidate.name} (\`${candidate.id}\`)`)
              .join(", ")}.`
          : "";
      return {
        error: `No Store connector matched "${query}".${hint} If no connector fits, proceed via the browser/computer fallback.`,
      };
    }

    const state = await getNativeConnectorReadiness(
      options.stellaDataDir,
      entry,
    );
    const toolCount = state.toolCount;
    const executable = state.executable;
    const diagnostics = {
      id: entry.id,
      catalogSource: catalog.sources[entry.id] ?? catalog.source,
      provider: entry.provider,
      enabled: state.enabled,
      providerStatus: state.authStatus,
      accountVerified: state.accountVerified,
      toolCount,
      executable,
    };
    if (executable) {
      return {
        result: `${entry.name} is enabled and exposes ${toolCount} executable tool${toolCount === 1 ? "" : "s"} (integration id \`${entry.id}\`, catalog: ${diagnostics.catalogSource}, provider: ${entry.provider}).${state.accountVerified ? " The provider account is connected." : " Backend account linkage is managed server-side and was not independently verified by this status check."} Agents can inspect it with \`stella-connect tools ${entry.id}\`.`,
        details: { ...diagnostics, status: "executable" },
      };
    }

    if (toolCount === 0) {
      return {
        result: `${entry.name} ${state.enabled ? "is locally enabled, but" : "exists, but"} the resolved ${entry.provider} catalog entry exposes no executable tools. It is not ready to use.`,
        details: { ...diagnostics, status: "not_executable" },
      };
    }

    const priorDecline = await getConnectorDecline(
      options.stellaDataDir,
      entry.id,
    );
    if (priorDecline) {
      return {
        result: `The user previously declined connecting ${entry.name}, so no connect card was shown. If it comes up, mention once — concisely — that they can connect ${entry.name} from the Store whenever they like, then proceed by other means (agents fall back to the browser). Do not offer again.`,
        details: { id: entry.id, status: "declined_previously" },
      };
    }

    if (!entry.connectable || !options.requestConnectorConnection) {
      return {
        result: `${entry.name} ${state.enabled ? "is locally enabled but does not have a verified provider credential" : "exists in the catalog"} and cannot be connected from here${entry.connectable ? "" : " (its connect flow isn't available in this build)"}. It is not ready to use; proceed via the browser/computer fallback or the Store.`,
        details: { ...diagnostics, status: "not_connectable" },
      };
    }

    const outcome = await options.requestConnectorConnection(
      {
        id: entry.id,
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
        ...(entry.category ? { category: entry.category } : {}),
        ...(reason ? { reason } : {}),
        ...(context?.conversationId
          ? { conversationId: context.conversationId }
          : {}),
      },
      extras?.signal,
    );

    if (outcome.ok) {
      return {
        result: `${entry.name} is now connected — the user approved the connect card. Continue the original task immediately (do not re-ask what they wanted); agents use it via \`stella-connect call ${entry.id} …\`.`,
        details: { id: entry.id, status: "connected" },
      };
    }
    if (outcome.reason === "declined") {
      await recordConnectorDecline(options.stellaDataDir, entry.id).catch(
        () => undefined,
      );
      return {
        result: `The user declined connecting ${entry.name}. Tell them once — concisely — that they can always connect it from the Store later, then proceed with the task by other means (the executing agent can use the browser). Do not offer ${entry.name} again.`,
        details: { id: entry.id, status: "declined" },
      };
    }
    if (outcome.reason === "cancelled" && extras?.signal?.aborted) {
      // The turn itself was cancelled; the desktop card was settled as
      // cancelled too. Nothing to tell the user.
      return {
        result: `The turn was cancelled before the user answered the ${entry.name} connect card.`,
        details: { id: entry.id, status: "cancelled" },
      };
    }
    if (outcome.reason === "cancelled" || outcome.reason === "timeout") {
      // No decline is persisted for these — suppression only holds for
      // the current context window (the availability reminder's window
      // gate), so the honest phrasing is "for now", not "ever" or even
      // "this conversation".
      return {
        result: `The connect card for ${entry.name} was ${outcome.reason === "timeout" ? "not answered in time" : "dismissed"}. Don't re-offer it for now; mention once that ${entry.name} is available in the Store, and proceed via other means (browser fallback).`,
        details: { id: entry.id, status: outcome.reason },
      };
    }
    return {
      error: `Could not run the ${entry.name} connect flow: ${outcome.reason}. Proceed via the browser/computer fallback.`,
    };
  },
});
