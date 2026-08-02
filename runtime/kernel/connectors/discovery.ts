/**
 * Lightweight connector discovery for agents.
 *
 * Agents deliberately do not get the integration catalog in context —
 * only enabled connectors surface (as skills). When a user request
 * implies an external service ("check my Gmail…"), the agent runs
 * `stella-connect discover <keywords>` and gets back a handful of
 * compact matches from the backend Composio Store catalog, each annotated
 * with enabled/declined state so the agent knows whether to use it, offer an
 * in-chat connect card, or stay quiet.
 *
 * Scoring is intentionally dumb (token prefix/substring over id, name,
 * category, description): the caller is a language model that already
 * did the semantic work of picking keywords.
 */

import {
  buildNativeConnectorCatalog,
  type NativeConnectorCatalogEntry,
  type NativeConnectorCatalogOverride,
} from "./native-integrations.js";
import { listConnectorDeclines } from "./connect-preferences.js";

export type ConnectorDiscoveryKind = "native";

export type ConnectorDiscoveryMatch = {
  id: string;
  name: string;
  kind: ConnectorDiscoveryKind;
  description: string;
  category?: string;
  provider?: NativeConnectorCatalogEntry["provider"];
  /** Whether this integration is enabled locally in the Store. */
  enabled: boolean;
  /** Whether Stella can currently run a connect flow for this entry. */
  connectable: boolean;
  /** The user declined an in-chat connect offer for this integration. */
  declined: boolean;
  score: number;
};

export const DISCOVERY_RESULT_LIMIT = 8;
const DESCRIPTION_LIMIT = 140;

const normalizeQueryTokens = (query: string): string[] => {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return [...new Set(tokens)];
};

const truncateDescription = (value: string | undefined): string => {
  const collapsed = (value ?? "").replace(/\s+/gu, " ").trim();
  if (collapsed.length <= DESCRIPTION_LIMIT) return collapsed;
  return `${collapsed.slice(0, DESCRIPTION_LIMIT - 1)}…`;
};

type ScoreFields = {
  id: string;
  name: string;
  category?: string;
  description?: string;
};

/**
 * Exported for tests. Exact id/name hits dominate so `discover gmail`
 * always puts the Gmail integration first even though "mail" appears in
 * dozens of descriptions.
 */
export const scoreConnectorMatch = (
  tokens: readonly string[],
  fields: ScoreFields,
): number => {
  if (tokens.length === 0) return 0;
  const id = fields.id.toLowerCase();
  const name = fields.name.toLowerCase();
  const nameTokens = name.split(/[^a-z0-9]+/u).filter(Boolean);
  const idTokens = id.split(/[^a-z0-9]+/u).filter(Boolean);
  const category = (fields.category ?? "").toLowerCase();
  const description = (fields.description ?? "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (id === token || name === token) {
      score += 50;
    } else if (
      idTokens.includes(token) ||
      nameTokens.includes(token)
    ) {
      score += 30;
    } else if (
      idTokens.some((entry) => entry.startsWith(token)) ||
      nameTokens.some((entry) => entry.startsWith(token))
    ) {
      score += 20;
    } else if (id.includes(token) || name.includes(token)) {
      score += 12;
    } else if (category.includes(token)) {
      score += 6;
    } else if (description.includes(token)) {
      score += 3;
    }
  }
  return score;
};

export const discoverConnectors = async (
  stellaAppDir: string,
  query: string,
  options: {
    catalogOverride?: NativeConnectorCatalogOverride;
    /** Native connectors that are enabled in the Store (by id). */
    enabledNativeIds: ReadonlySet<string>;
    limit?: number;
  },
): Promise<ConnectorDiscoveryMatch[]> => {
  const tokens = normalizeQueryTokens(query);
  if (tokens.length === 0) return [];

  const declines = await listConnectorDeclines(stellaAppDir).catch(
    (): Awaited<ReturnType<typeof listConnectorDeclines>> => ({}),
  );

  const matches: ConnectorDiscoveryMatch[] = [];

  for (const entry of buildNativeConnectorCatalog(options.catalogOverride)) {
    const score = scoreConnectorMatch(tokens, entry);
    if (score <= 0) continue;
    matches.push({
      id: entry.id,
      name: entry.name,
      kind: "native",
      description: truncateDescription(entry.description),
      category: entry.category,
      provider: entry.provider,
      enabled: options.enabledNativeIds.has(entry.id),
      connectable: entry.connectable,
      declined: Boolean(declines[entry.id]),
      score,
    });
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    // Same score: prefer what's already usable, then stable by name.
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  return matches.slice(0, options.limit ?? DISCOVERY_RESULT_LIMIT);
};
