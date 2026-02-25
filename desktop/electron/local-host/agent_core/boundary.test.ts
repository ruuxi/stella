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

  test("runtime adapter consumes extracted core helpers", () => {
    const source = read("electron/local-host/agent_runtime.ts");
    expect(source).toContain('from "./agent_core/model_proxy.js"');
    expect(source).toContain('from "./agent_core/runtime_utils.js"');
    expect(source).toContain('from "./agent_core/tool_call_ids.js"');
  });
});
