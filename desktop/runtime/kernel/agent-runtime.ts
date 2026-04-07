import {
  shutdownExternalEngineIntegrations,
  runExternalOrchestratorTurn,
  runExternalSubagentTurn,
} from "./agent-runtime/external-engines.js";
import {
  runPiOrchestratorTurn,
  runPiSubagentTask,
} from "./agent-runtime/pi-execution.js";
import { DEFAULT_MAX_TURNS } from "./agent-runtime/shared.js";
import type { SubagentRunResult } from "./agent-runtime/types.js";

export type {
  SelfModAppliedPayload,
  SelfModMonitor,
  RuntimeStreamEvent,
  RuntimeToolStartEvent,
  RuntimeToolEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeEndEvent,
  RuntimeUserMessageEvent,
  RuntimeRunCallbacks,
} from "./agent-runtime/types.js";

import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./agent-runtime/types.js";

export async function runOrchestratorTurn(
  opts: OrchestratorRunOptions,
): Promise<string> {
  const integratedResult = await runExternalOrchestratorTurn(opts);
  if (integratedResult) {
    return integratedResult;
  }
  return await runPiOrchestratorTurn(opts);
}

export async function runSubagentTask(
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> {
  const integratedResult = await runExternalSubagentTurn(opts);
  if (integratedResult) {
    return integratedResult;
  }
  return await runPiSubagentTask(opts);
}

export const shutdownSubagentRuntimes = (): void => {
  shutdownExternalEngineIntegrations();
};

export const PI_RUNTIME_MAX_TURNS = DEFAULT_MAX_TURNS;
