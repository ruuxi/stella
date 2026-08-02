import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_BINARY_TAG,
  encodeBridgeBinaryValues,
} from "../../electron/services/mobile-bridge/binary-codec.js";
import { adaptLegacyMobileArgs } from "../../electron/services/mobile-bridge/legacy-args.js";
import { isMobileReadableStellaPath } from "../../electron/ipc/display-handlers.js";

/**
 * Mirrors the phone shim's `reviveBridgeBinary` so the wire format is verified
 * end to end rather than just asserted on the encoding side.
 */
const reviveBinary = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record[BRIDGE_BINARY_TAG] === "string") {
    return Uint8Array.from(Buffer.from(record.data as string, "base64"));
  }
  for (const key of Object.keys(record)) {
    record[key] = reviveBinary(record[key]);
  }
  return record;
};

describe("mobile bridge argument adaptation", () => {
  it("packs the positional arguments older phone builds send for browser fetches", () => {
    // The exact shape that produced "Cannot read properties of undefined
    // (reading 'trim')": the handler destructures payload.url off a bare string.
    const adapted = adaptLegacyMobileArgs("browser:fetchJson", [
      "https://api.example.com/search",
      { method: "GET", headers: { Accept: "application/json" } },
    ]);

    expect(adapted).toEqual([
      {
        url: "https://api.example.com/search",
        init: { method: "GET", headers: { Accept: "application/json" } },
      },
    ]);
  });

  it("leaves an already-packed payload untouched", () => {
    const packed = [{ url: "https://api.example.com", init: undefined }];
    expect(adaptLegacyMobileArgs("browser:fetchJson", packed)).toBe(packed);
  });

  it("packs scalar arguments for capabilities the shim auto-installs", () => {
    expect(adaptLegacyMobileArgs("selfmod:apply", ["abc123"])).toEqual([
      { commitHash: "abc123" },
    ]);
    expect(
      adaptLegacyMobileArgs("selfmod:revert", ["abc123", 1]),
    ).toEqual([
      { commitHash: "abc123", steps: 1 },
    ]);
    expect(adaptLegacyMobileArgs("selfmod:recentCommits", [10])).toEqual([
      { limit: 10 },
    ]);
    expect(
      adaptLegacyMobileArgs("llmCredentials:delete", ["anthropic"]),
    ).toEqual([{ provider: "anthropic" }]);
  });

  it("passes through channels with no legacy shape and empty calls", () => {
    const args = ["anything", 2];
    expect(adaptLegacyMobileArgs("localChat:listMessages", args)).toBe(args);
    expect(adaptLegacyMobileArgs("browser:fetchJson", [])).toEqual([]);
  });

  it("omits trailing arguments the caller did not supply", () => {
    expect(
      adaptLegacyMobileArgs("media:saveOutput", ["https://x/y.png", "y.png"]),
    ).toEqual([{ url: "https://x/y.png", fileName: "y.png" }]);
  });
});

describe("mobile bridge binary payloads", () => {
  it("survives the JSON lane as real bytes instead of a numeric-keyed object", () => {
    const bytes = new TextEncoder().encode('{"suite_id":"krea"}');
    const handlerResult = {
      bytes,
      sizeBytes: bytes.byteLength,
      mimeType: "application/json",
      missing: false,
    };

    // What the phone actually receives: encoded, JSON round-tripped, revived.
    const wire = JSON.parse(
      JSON.stringify(encodeBridgeBinaryValues(handlerResult)),
    );
    const revived = reviveBinary(wire) as { bytes: Uint8Array };

    expect(revived.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(revived.bytes)).toBe('{"suite_id":"krea"}');
  });

  it("regression: an unencoded Uint8Array degrades into a plain object", () => {
    const raw = JSON.parse(JSON.stringify({ bytes: new Uint8Array([1, 2]) }));
    expect(raw.bytes).not.toBeInstanceOf(Uint8Array);
    expect(raw.bytes).toEqual({ "0": 1, "1": 2 });
  });

  it("encodes nested binary and leaves other values identical", () => {
    const input = { list: [{ blob: new Uint8Array([7]) }], name: "krea" };
    const encoded = encodeBridgeBinaryValues(input) as {
      list: { blob: Record<string, unknown> }[];
      name: string;
    };
    expect(encoded.list[0].blob[BRIDGE_BINARY_TAG]).toBe("base64");
    expect(encoded.name).toBe("krea");
  });

  it("returns non-binary payloads by reference so ordinary calls are unaffected", () => {
    const payload = { messages: [{ id: "1" }] };
    expect(encodeBridgeBinaryValues(payload)).toBe(payload);
  });
});

describe("mobile display read scope", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-read-scope-"));
    await fs.mkdir(path.join(dataDir, "outputs", "krea-bench"), {
      recursive: true,
    });
    await fs.mkdir(path.join(dataDir, "media"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "connectors"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "outputs", "krea-bench", "index.json"),
      "{}",
    );
    await fs.writeFile(path.join(dataDir, "llm_credentials.json"), "{}");
    await fs.writeFile(
      path.join(dataDir, "connectors", ".credentials.json"),
      "{}",
    );
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("allows Stella's own outputs and media so apps can load their data", async () => {
    await expect(
      isMobileReadableStellaPath(
        path.join(dataDir, "outputs", "krea-bench", "index.json"),
        dataDir,
      ),
    ).resolves.toBe(true);
    await expect(
      isMobileReadableStellaPath(
        path.join(dataDir, "media", "shot.png"),
        dataDir,
      ),
    ).resolves.toBe(true);
  });

  it("keeps credential stores and the rest of the home directory out of reach", async () => {
    await expect(
      isMobileReadableStellaPath(
        path.join(dataDir, "llm_credentials.json"),
        dataDir,
      ),
    ).resolves.toBe(false);
    await expect(
      isMobileReadableStellaPath(
        path.join(dataDir, "connectors", ".credentials.json"),
        dataDir,
      ),
    ).resolves.toBe(false);
    await expect(
      isMobileReadableStellaPath("/Users/rahul/.ssh/id_rsa", dataDir),
    ).resolves.toBe(false);
  });

  it("does not treat a sibling directory sharing the prefix as inside outputs", async () => {
    await expect(
      isMobileReadableStellaPath(
        path.join(dataDir, "outputs-private", "secret.json"),
        dataDir,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a symlink planted in outputs that escapes to a credential file", async () => {
    const link = path.join(dataDir, "outputs", "escape.json");
    await fs.symlink(path.join(dataDir, "llm_credentials.json"), link);
    await expect(isMobileReadableStellaPath(link, dataDir)).resolves.toBe(
      false,
    );
  });

  it("denies everything when the data directory is unknown", async () => {
    await expect(
      isMobileReadableStellaPath(path.join(dataDir, "outputs", "x.json"), null),
    ).resolves.toBe(false);
  });
});
