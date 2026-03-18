import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

describe("workspace game template", () => {
  it("type-checks without generating a fresh app first", () => {
    const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const tsconfigPath = path.join(
      repoRoot,
      "templates",
      "workspace-game-app",
      "tsconfig.json",
    );

    const result = spawnSync(process.execPath, [
      tscBin,
      "--noEmit",
      "-p",
      tsconfigPath,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });

    if (result.status !== 0) {
      throw new Error(
        [
          "workspace game template should type-check",
          result.stdout.trim(),
          result.stderr.trim(),
        ].filter(Boolean).join("\n\n"),
      );
    }

    expect(result.status).toBe(0);
  });
});
