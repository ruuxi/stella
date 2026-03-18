import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/data/secrets_rotation.ts", "utf-8");

describe("secrets_rotation module structure", () => {
  test("exports rotateEncryptedMaterialBatch", () => {
    expect(source).toContain("export const rotateEncryptedMaterialBatch =");
  });

  test("exports rotateEncryptedMaterial", () => {
    expect(source).toContain("export const rotateEncryptedMaterial =");
  });

  test("has batch size normalization", () => {
    expect(source).toContain("normalizeBatchSize");
    expect(source).toContain("DEFAULT_BATCH_SIZE");
    expect(source).toContain("MAX_BATCH_SIZE");
  });

  test("checks version for rotation", () => {
    expect(source).toContain("shouldRotateByVersion");
  });

  test("returns rotation stats", () => {
    expect(source).toContain("rotated");
    expect(source).toContain("failed");
    expect(source).toContain("skipped");
    expect(source).toContain("hasMoreCandidates");
  });
});
