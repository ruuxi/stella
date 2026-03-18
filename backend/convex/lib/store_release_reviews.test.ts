import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewableStoreArtifact } from "./store_release_reviews";

const toBase64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("parseReviewableStoreArtifact", () => {
  it("extracts code and image review inputs from a blueprint artifact", () => {
    const artifactBody = JSON.stringify({
      kind: "self_mod_blueprint",
      schemaVersion: 1,
      manifest: {
        packageId: "weather-widget",
        featureId: "weather-widget-feature",
        releaseNumber: 2,
        displayName: "Weather Widget",
        description: "Adds a weather widget",
        batchIds: ["batch-1"],
        commitHashes: ["commit-1"],
        files: ["src/widget.ts", "assets/logo.png", "src/old.ts"],
        createdAt: Date.now(),
      },
      applyGuidance: "Use as reference.",
      batches: [
        {
          batchId: "batch-1",
          ordinal: 1,
          commitHash: "commit-1",
          files: ["src/widget.ts", "assets/logo.png", "src/old.ts"],
          subject: "Weather widget",
          body: "",
          patch: [
            "diff --git a/src/widget.ts b/src/widget.ts",
            "--- a/src/widget.ts",
            "+++ b/src/widget.ts",
            "@@",
            "+export const widget = true;",
            "diff --git a/src/old.ts b/src/old.ts",
            "--- a/src/old.ts",
            "+++ /dev/null",
            "@@",
            "-export const old = true;",
          ].join("\n"),
        },
      ],
      files: [
        {
          path: "src/widget.ts",
          changeType: "create",
          referenceContentBase64: toBase64("export const widget = true;\n"),
        },
        {
          path: "assets/logo.png",
          changeType: "create",
          referenceContentBase64: "aGVsbG8=",
        },
        {
          path: "src/old.ts",
          changeType: "delete",
          deleted: true,
        },
      ],
    });

    const parsed = parseReviewableStoreArtifact(artifactBody);
    assert.deepEqual(parsed.codeFiles.map((file) => file.path), ["src/widget.ts", "src/old.ts"]);
    assert.match(parsed.codeFiles[0]?.contentText ?? "", /widget = true/);
    assert.match(parsed.codeFiles[1]?.patchText ?? "", /src\/old\.ts/);
    assert.deepEqual(parsed.imageFiles, [
      {
        path: "assets/logo.png",
        changeType: "create",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ]);
  });

  it("rejects artifacts that are not blueprint JSON", () => {
    assert.throws(() => parseReviewableStoreArtifact(JSON.stringify({ kind: "snapshot" })));
  });
});
