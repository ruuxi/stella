import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifestPath = path.resolve(
  process.cwd(),
  "stella-browser",
  "extension",
  "manifest.json",
);

describe("stella-browser bridge config", () => {
  it("keeps the extension manifest key required for the native messaging allowlist", async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      key?: string;
    };
    const { STELLA_BROWSER_EXTENSION_ID } = await import(
      "../../../../runtime/kernel/tools/stella-browser-bridge-config.js"
    );

    expect(STELLA_BROWSER_EXTENSION_ID).toBe("cgbnommjhnegjicfpklioofjphobpgfi");
    expect(manifest.key).toBe(
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmLF4sjYG6lWQXgWuQ0S/o3U2O9HQoyf+8ZaDIKZjysnv3s3sC/gVeXnHSzRrrZ4HYqTy+gChoSZS4LNN33COPbfs/+aGl4e5LInHeS5o63bMYyLZdqFl34DmJ9H2Z+/Unww+Ez1rGOJmfD73Ak5sH/nJpiY8nnKZCviUHJxWDtbKsT8fqA10GEcywyg4/z0J8Bp8pVPjsQtuoxa+Ze6GEmiRdyLk9LFMNRR+lV4JQoPszFckALSo5aCokSC3vVoPVxd1oUZK9ZgiJnfJ0/FpKdYft0jey7K/QVdM4cjVVvzk0DggOv5D3/fCBQPGd9fBxca0MOuwiSMI+hSY7b+LFQIDAQAB",
    );
  });
});
