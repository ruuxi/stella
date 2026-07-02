import { describe, expect, it } from "vitest";
import {
  BRIDGE_REPLAY_WINDOW,
  createBridgeReplayGuard,
  decryptBridgeBytes,
  decryptBridgePayload,
  encryptBridgeBytes,
  encryptBridgePayload,
  type BridgeCryptoSession,
} from "../../electron/services/mobile-bridge/crypto.js";
import { randomBytes } from "crypto";

const makeSessionPair = (): {
  sender: BridgeCryptoSession;
  receiver: BridgeCryptoSession;
} => {
  const key = new Uint8Array(randomBytes(32));
  return {
    sender: { sessionId: "session-1", key, txSeq: 0 },
    receiver: { sessionId: "session-1", key: new Uint8Array(key), txSeq: 0 },
  };
};

describe("bridge envelope compression", () => {
  it("round-trips compressed payloads identically", () => {
    const { sender, receiver } = makeSessionPair();
    const payload = {
      messages: Array.from({ length: 50 }, (_, index) => ({
        localMessageId: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: "The same sort of repetitive transcript text appears here.",
      })),
    };
    const uncompressed = encryptBridgePayload(
      { ...sender, txSeq: 0 },
      "d2m",
      payload,
    );
    const compressed = encryptBridgePayload(sender, "d2m", payload, {
      compress: true,
    });
    expect(compressed.z).toBe(1);
    expect(compressed.ct.length).toBeLessThan(uncompressed.ct.length);
    expect(decryptBridgePayload(receiver, "d2m", compressed)).toEqual(payload);
  });

  it("skips the z flag when compression does not shrink the payload", () => {
    const { sender, receiver } = makeSessionPair();
    // Tiny payload — deflate's own header/overhead makes it larger.
    const payload = { a: 1 };
    const envelope = encryptBridgePayload(sender, "d2m", payload, {
      compress: true,
    });
    expect(envelope.z).toBeUndefined();
    expect(decryptBridgePayload(receiver, "d2m", envelope)).toEqual(payload);
  });

  it("legacy peers' envelopes (no z, no options) still decrypt", () => {
    const { sender, receiver } = makeSessionPair();
    const envelope = encryptBridgePayload(sender, "m2d", { legacy: true });
    expect("z" in envelope).toBe(false);
    expect(decryptBridgePayload(receiver, "m2d", envelope)).toEqual({
      legacy: true,
    });
  });
});

describe("bridge replay guard", () => {
  it("rejects duplicates and stale seqs, tolerates in-window reorder", () => {
    const guard = createBridgeReplayGuard();
    guard.check(5);
    guard.check(3);
    guard.check(4);
    expect(() => guard.check(4)).toThrow(/duplicate/);
    guard.check(BRIDGE_REPLAY_WINDOW + 50);
    expect(() => guard.check(3)).toThrow(/stale|duplicate/);
    expect(() => guard.check(0)).toThrow(/invalid/);
  });

  it("rejects a replayed envelope end-to-end", () => {
    const { sender, receiver } = makeSessionPair();
    const guard = createBridgeReplayGuard();
    const envelope = encryptBridgePayload(sender, "m2d", { once: true });
    expect(decryptBridgePayload(receiver, "m2d", envelope, guard)).toEqual({
      once: true,
    });
    expect(() =>
      decryptBridgePayload(receiver, "m2d", envelope, guard),
    ).toThrow(/duplicate/);
  });
});

describe("binary frame lane", () => {
  it("bytes in = bytes out", () => {
    const { sender, receiver } = makeSessionPair();
    const bytes = new Uint8Array(randomBytes(100_000));
    const original = new Uint8Array(bytes);
    const frame = encryptBridgeBytes(sender, "d2m", bytes);
    expect(frame.ciphertext.byteLength).toBe(original.byteLength + 16);
    const decoded = decryptBridgeBytes(receiver, "d2m", frame);
    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
  });

  it("binds direction + lane into the AAD", () => {
    const { sender, receiver } = makeSessionPair();
    const frame = encryptBridgeBytes(sender, "m2d", new Uint8Array([1, 2, 3]));
    expect(() => decryptBridgeBytes(receiver, "d2m", frame)).toThrow();
    // And a binary frame can't be replayed into the JSON lane.
    expect(() =>
      decryptBridgePayload(receiver, "m2d", {
        v: 1,
        alg: "x25519-hkdf-sha256-aes-256-gcm-v1",
        sid: "session-1",
        seq: frame.seq,
        iv: frame.iv,
        ct: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    ).toThrow();
  });
});
