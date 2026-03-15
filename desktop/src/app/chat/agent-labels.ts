import { AGENT_IDS, type AgentId } from "@/shared/contracts/agent-runtime";

/** Get a friendly label for agent types */
export const getAgentLabel = (agentType: AgentId | string): string => {
  switch (agentType) {
    case AGENT_IDS.GENERAL:
      return "Working";
    case AGENT_IDS.EXPLORE:
      return "Exploring";
    case AGENT_IDS.BROWSER:
    case AGENT_IDS.APP:
      return "Browsing";
    case AGENT_IDS.SELF_MOD:
      return "Modifying";
    case AGENT_IDS.ORCHESTRATOR:
      return "Coordinating";
    default:
      return agentType;
  }
};
