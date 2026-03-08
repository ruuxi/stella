import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("agent core boundaries", () => {
  test("stella runtime stays isolated from legacy runtime files", () => {
    const source = read("packages/stella-runtime/src/agent-runtime.ts");
    expect(source).toContain('from "./extensions/stella/local-task-manager.js"');
    expect(source).toContain('from "./extensions/stella/tools-types.js"');
    expect(source).not.toContain("../local-host/");
    expect(source).not.toContain("../system/");
  });
});
