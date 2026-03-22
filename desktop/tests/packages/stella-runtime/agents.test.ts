import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentsFromHome } from "../../../packages/runtime-kernel/agents/agents.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";

const tempRoots: string[] = [];

const createTempAgentsHome = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-agents-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("loadAgentsFromHome", () => {
  it("includes bundled core agents when no local agents exist", async () => {
    const agentsPath = createTempAgentsHome();

    const agents = await loadAgentsFromHome(agentsPath);

    expect(agents.map((agent) => agent.id)).toEqual([
      AGENT_IDS.ORCHESTRATOR,
      AGENT_IDS.SCHEDULE,
      AGENT_IDS.GENERAL,
      AGENT_IDS.SELF_MOD,
      AGENT_IDS.EXPLORE,
      AGENT_IDS.APP,
    ]);
  });

  it("lets local runtime agents override bundled agents by agent type", async () => {
    const agentsPath = createTempAgentsHome();
    const generalDir = path.join(agentsPath, "custom-general");
    fs.mkdirSync(generalDir, { recursive: true });
    fs.writeFileSync(
      path.join(generalDir, "AGENT.md"),
      `---
name: Custom General
description: Local override
agentTypes:
  - general
---

Local prompt`,
      "utf-8",
    );

    const agents = await loadAgentsFromHome(agentsPath);

    expect(agents.find((agent) => agent.agentTypes.includes("general"))?.name).toBe("Custom General");
    expect(agents.some((agent) => agent.id === AGENT_IDS.GENERAL)).toBe(false);
    expect(agents.some((agent) => agent.id === AGENT_IDS.SELF_MOD)).toBe(true);
    expect(agents.some((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)).toBe(true);
  });
});
