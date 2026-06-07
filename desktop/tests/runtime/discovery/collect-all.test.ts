import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectAllSignals } from "../../../../runtime/discovery/collect-all.js";

const tempDirs: string[] = [];

const createTempHome = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-discovery-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("collectAllSignals", () => {
  it("persists selected categories under Stella home", async () => {
    const stellaDataDir = await createTempHome();

    await collectAllSignals(stellaDataDir, []);

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(stellaDataDir, "discovery_categories.json"),
        "utf-8",
      ),
    ) as { categories?: unknown; updatedAt?: unknown };

    expect(persisted.categories).toEqual([]);
    expect(typeof persisted.updatedAt).toBe("number");
  });
});
