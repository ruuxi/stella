import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("agent core boundaries", () => {
  test("pi runtime stays isolated from legacy runtime files", () => {
    const source = read("electron/pi-runtime/pi_agent_runtime.ts");
    expect(source).toContain('from "./extensions/stella/local_task_manager.js"');
    expect(source).toContain('from "./extensions/stella/tools-types.js"');
    expect(source).not.toContain("../local-host/");
    expect(source).not.toContain("../system/");
  });
});
