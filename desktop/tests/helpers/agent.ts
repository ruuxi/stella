import { LocalAgentManager } from "../../runtime/kernel/agents/local-agent-manager.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForAgentSettled(
  manager: LocalAgentManager,
  agentId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await manager.getAgent(agentId);
    if (snapshot && snapshot.status !== "running") {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Task ${agentId} did not finish in time.`);
}
