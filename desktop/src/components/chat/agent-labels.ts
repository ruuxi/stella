/** Get a friendly label for agent types */
export const getAgentLabel = (agentType: string): string => {
  switch (agentType) {
    case "general":
      return "Working";
    case "explore":
      return "Exploring";
    case "browser":
      return "Browsing";
    case "self_mod":
      return "Modifying";
    case "orchestrator":
      return "Coordinating";
    default:
      return agentType;
  }
};
