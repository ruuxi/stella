import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const electronRoot = path.join(repoRoot, "desktop/electron");

const readTsFiles = async (dir: string): Promise<Array<{ file: string; source: string }>> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return [readTsFiles(absolute)];
      if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
      return [
        fs.readFile(absolute, "utf-8").then((source) => ({
          file: path.relative(repoRoot, absolute),
          source,
        })),
      ];
    }),
  );
  return files.flat();
};

describe("Electron mutable state path callers", () => {
  it("does not pass repo-root variables through resolveStellaStatePath", async () => {
    const previousStellaState = process.env.STELLA_STATE;
    const previousStellaDataRoot = process.env.STELLA_DATA_ROOT;
    delete process.env.STELLA_STATE;
    delete process.env.STELLA_DATA_ROOT;

    try {
      const offenders = (await readTsFiles(electronRoot)).flatMap(({ file, source }) =>
        [...source.matchAll(/resolveStellaStatePath\((stellaRoot|root|stellaHome|stellaHomePath)\)/g)]
          .map((match) => `${file}: ${match[0]}`),
      );

      expect(offenders).toEqual([]);
    } finally {
      if (previousStellaState === undefined) delete process.env.STELLA_STATE;
      else process.env.STELLA_STATE = previousStellaState;

      if (previousStellaDataRoot === undefined) delete process.env.STELLA_DATA_ROOT;
      else process.env.STELLA_DATA_ROOT = previousStellaDataRoot;
    }
  });
});
