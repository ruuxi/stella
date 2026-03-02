import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("agent core boundaries", () => {
  test("core helpers stay runtime-agnostic", () => {
    const files = [
      "electron/local-host/agent_core/failover.ts",
      "electron/local-host/agent_core/model_proxy.ts",
      "electron/local-host/agent_core/runtime_utils.ts",
      "electron/local-host/agent_core/tool_call_ids.ts",
      "electron/local-host/agent_core/tool_call_factory.ts",
    ];
    const forbiddenImports = [
      "run_journal",
      "agent_tools",
      "remote_tools",
      "electron",
      "convex/",
      "_generated/api",
      "_generated/server",
    ];

    for (const file of files) {
      const source = read(file);
      for (const forbidden of forbiddenImports) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  test("pi runtime stays isolated from local-host runtime files", () => {
    const source = read("electron/pi-runtime/pi_agent_runtime.ts");
    expect(source).toContain('from "./extensions/stella/local_task_manager.js"');
    expect(source).toContain('from "./extensions/stella/tools-types.js"');
    expect(source).not.toContain("../local-host/");
  });
});
