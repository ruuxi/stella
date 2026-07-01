/**
 * Per-turn map-card derivation.
 *
 * The orchestrator's `map` tool persists its resolved `map-route` artifact
 * onto the `tool_result` payload (`details: { map }`, spread by the worker —
 * see `runtime/kernel/tools/defs/map.ts`). Each successful call on the turn
 * becomes one inline interactive map card, in call order.
 *
 * Purely a renderer affordance derived from already-persisted events — the
 * model only sees the tool's text summary.
 */

import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  isMapRouteArtifact,
  type MapRouteArtifact,
} from "../../../../../runtime/contracts/map-artifact.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";

/** Keep a runaway turn from stacking maps down the timeline. */
const MAX_MAP_CARDS_PER_TURN = 3;

export type TurnMapArtifact = {
  /** Stable per-turn key (the tool_result event id). */
  id: string;
  map: MapRouteArtifact;
};

export const deriveTurnMapArtifacts = (
  events: readonly EventRecord[],
): TurnMapArtifact[] => {
  const cards: TurnMapArtifact[] = [];
  for (const event of events) {
    if (!event || event.type !== "tool_result") continue;
    const payload = event.payload as
      | {
          toolName?: unknown;
          error?: unknown;
          agentType?: unknown;
          map?: unknown;
        }
      | undefined;
    if (!payload || payload.toolName !== "map") continue;
    if (typeof payload.error === "string" && payload.error) continue;
    // Orchestrator-only affordance (absent agentType means orchestrator,
    // mirroring the worker's persistence default).
    const agentType =
      typeof payload.agentType === "string" ? payload.agentType : undefined;
    if (agentType !== undefined && agentType !== AGENT_IDS.ORCHESTRATOR) {
      continue;
    }
    if (!isMapRouteArtifact(payload.map)) continue;
    cards.push({ id: event._id, map: payload.map });
    if (cards.length >= MAX_MAP_CARDS_PER_TURN) break;
  }
  return cards;
};
