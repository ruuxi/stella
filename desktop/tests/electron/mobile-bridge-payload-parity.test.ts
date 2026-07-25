import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMobileBridgeCapabilityManifest,
  MOBILE_BRIDGE_REQUEST_CAPABILITIES,
  PHONE_ONLY_REQUEST_CHANNELS,
} from "../../electron/services/mobile-bridge/capabilities.js";
import { IPC_PAYLOAD_CONTRACT } from "../../electron/services/mobile-bridge/ipc-payload-contract.generated.js";
import { adaptLegacyMobileArgs } from "../../electron/services/mobile-bridge/legacy-args.js";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * The phone re-implements `window.electronAPI` as a shim. Any channel whose
 * payload shape the shim spells differently from preload breaks silently: the
 * handler destructures a field that is `undefined`, and the app either throws
 * or renders an empty state. These tests keep the derived contract — the thing
 * the phone packs against — honest.
 */
describe("ipc payload contract stays derived from preload", () => {
  it("is regenerated whenever preload's invoke calls change", () => {
    // Fails when preload gained or reshaped a channel and the generated file
    // was not refreshed. Fix: node scripts/derive-ipc-payload-contract.mjs
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/derive-ipc-payload-contract.mjs", "--check"],
        { cwd: desktopDir, stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("captures the packed shapes the handlers destructure", () => {
    // Anchors the extractor itself: each of these was a real phone-side bug
    // caused by sending a different shape.
    expect(IPC_PAYLOAD_CONTRACT["browser:fetchJson"]).toEqual({
      kind: "object",
      fields: ["url", "init"],
    });
    expect(IPC_PAYLOAD_CONTRACT["media:saveOutput"]).toEqual({
      kind: "object",
      fields: ["url", "fileName", "kind"],
    });
    expect(IPC_PAYLOAD_CONTRACT["selfmod:revert"]).toEqual({
      kind: "object",
      fields: ["commitHash", "steps"],
    });
    expect(IPC_PAYLOAD_CONTRACT["display:readFile"]).toEqual({
      kind: "object",
      fields: ["filePath", "conversationId"],
    });
  });

  it("distinguishes forwarded payloads and argument-less calls", () => {
    expect(IPC_PAYLOAD_CONTRACT["localChat:listMessages"]).toEqual({
      kind: "passthrough",
    });
    expect(IPC_PAYLOAD_CONTRACT["ui:getState"]).toEqual({ kind: "none" });
  });
});

describe("every bridged channel reaches the phone with a shape", () => {
  it("covers all remote-request capabilities", () => {
    const uncovered = MOBILE_BRIDGE_REQUEST_CAPABILITIES.filter(
      (capability) =>
        !IPC_PAYLOAD_CONTRACT[capability.channel] &&
        !PHONE_ONLY_REQUEST_CHANNELS[capability.channel],
    ).map((capability) => `${capability.path} -> ${capability.channel}`);

    // A new bridged channel lands here until it is either exposed through
    // preload (giving it a derived contract) or declared phone-only with a
    // reason. That decision is the point: an unlisted channel is one the phone
    // would call with a shape nobody checked.
    expect(uncovered).toEqual([]);
  });

  it("does not allowlist channels that no handler answers", () => {
    // `miniBridge:*` sat in the manifest for a long time with no `ipcMain`
    // handler anywhere, so every call 404'd mid-flight.
    const channels = MOBILE_BRIDGE_REQUEST_CAPABILITIES.map(
      (capability) => capability.channel,
    );
    expect(channels).not.toContain("miniBridge:request");
  });

  it("keeps the phone-only exceptions honest", () => {
    // An exception that is no longer needed should be deleted, not left to
    // mask a channel that has since gained a real contract.
    const stale = Object.keys(PHONE_ONLY_REQUEST_CHANNELS).filter(
      (channel) => IPC_PAYLOAD_CONTRACT[channel],
    );
    expect(stale).toEqual([]);
  });

  it("ships each contract to the phone in the manifest", () => {
    const manifest = buildMobileBridgeCapabilityManifest();
    const fetchJson = manifest.capabilities.find(
      (capability) => capability.path === "browser.fetchJson",
    );
    expect(fetchJson).toMatchObject({
      mode: "remote-request",
      payload: { kind: "object", fields: ["url", "init"] },
    });

    // Every request capability with a contract carries it, so a phone can pack
    // for channels this desktop build learned about after the phone shipped.
    const missing = manifest.capabilities.filter(
      (capability) =>
        capability.mode === "remote-request" &&
        IPC_PAYLOAD_CONTRACT[capability.channel] &&
        !("payload" in capability),
    );
    expect(missing).toEqual([]);
  });
});

describe("legacy positional args are repacked from the derived contract", () => {
  it("packs the call shape that produced the undefined-trim crash", () => {
    expect(
      adaptLegacyMobileArgs("browser:fetchJson", [
        "https://api.example.com",
        { method: "GET" },
      ]),
    ).toEqual([{ url: "https://api.example.com", init: { method: "GET" } }]);
  });

  it("covers channels never named in this file, straight from the contract", () => {
    // Neither of these was ever hand-listed; they work because the shapes are
    // derived, which is what makes future channels safe too.
    expect(adaptLegacyMobileArgs("store:getPackage", ["pkg_1"])).toEqual([
      { packageId: "pkg_1" },
    ]);
    expect(adaptLegacyMobileArgs("permissions:request", ["screen"])).toEqual([
      { kind: "screen" },
    ]);
  });

  it("passes an already-packed payload through untouched", () => {
    const packed = [{ url: "https://api.example.com" }];
    expect(adaptLegacyMobileArgs("browser:fetchJson", packed)).toBe(packed);
  });

  it("never repacks a forwarded payload or an argument-less call", () => {
    const forwarded = [{ conversationId: "c1", limit: 50 }];
    expect(adaptLegacyMobileArgs("localChat:listMessages", forwarded)).toBe(
      forwarded,
    );
    expect(adaptLegacyMobileArgs("ui:getState", [])).toEqual([]);
  });
});
