import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentsFromHome } from "../../../electron/core/runtime/agents/agents.js";

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
      "orchestrator",
      "general",
      "self_mod",
      "explore",
      "app",
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
    expect(agents.some((agent) => agent.id === "general")).toBe(false);
    expect(agents.some((agent) => agent.id === "self_mod")).toBe(true);
    expect(agents.some((agent) => agent.id === "orchestrator")).toBe(true);
  });
});
