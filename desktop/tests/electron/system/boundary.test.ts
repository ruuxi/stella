import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("agent core boundaries", () => {
  test("stella runtime stays isolated from legacy runtime files", () => {
    const source = read("packages/runtime-kernel/agent-runtime.ts");
    expect(source).toContain('from "./agent-runtime/external-engines.js"');
    expect(source).toContain('from "./agent-runtime/pi-execution.js"');
    expect(source).toContain('from "./agent-runtime/shared.js"');
    expect(source).not.toContain('./self-mod/git.js');
    expect(source).not.toContain("../local-host/");
    expect(source).not.toContain("../system/");
    expect(source).not.toContain("../../../electron/system/");
  });
});
