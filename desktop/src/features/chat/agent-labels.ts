import {
  getAgentActivityLabel,
  type AgentId,
} from "../../../../runtime/contracts/agent-runtime.js";

/** Get a friendly label for agent types */
export const getAgentLabel = (agentType: AgentId | string): string =>
  getAgentActivityLabel(agentType) ?? agentType;
