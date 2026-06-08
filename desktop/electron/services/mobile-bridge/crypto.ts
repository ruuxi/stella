import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "crypto";

export const BRIDGE_CRYPTO_PROTOCOL = "x25519-hkdf-sha256-aes-256-gcm-v1";

export type BridgeCryptoDirection = "m2d" | "d2m";

export type BridgeEncryptedEnvelope = {
  v: 1;
  alg: typeof BRIDGE_CRYPTO_PROTOCOL;
  sid: string;
  seq: number;
  iv: string;
  ct: string;
};

export type BridgeKeyPair = {
  secretKey: Uint8Array;
  publicKey: string;
};

export type BridgeCryptoSession = {
  sessionId: string;
  key: Uint8Array;
  txSeq: number;
};

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_URL_LOOKUP = new Map(
  [...BASE64_URL_ALPHABET].map((char, index) => [char, index]),
);

export const bytesToBase64Url = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_URL_ALPHABET[(n >> 18) & 63];
    out += BASE64_URL_ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64_URL_ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64_URL_ALPHABET[n & 63];
  }
  return out;
};

export const base64UrlToBytes = (value: string) => {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of value) {
    const next = BASE64_URL_LOOKUP.get(char);
    if (next === undefined) {
      throw new Error("Invalid base64url value");
    }
    buffer = (buffer << 6) | next;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

export const createBridgeKeyPair = (): BridgeKeyPair => {
  const secretKey = new Uint8Array(randomBytes(32));
  return {
    secretKey,
    publicKey: bytesToBase64Url(x25519.getPublicKey(secretKey)),
  };
};

export const deriveBridgeCryptoSession = (args: {
  sessionId: string;
  secretKey: Uint8Array;
  peerPublicKey: string;
  mobilePublicKey: string;
  desktopPublicKey: string;
}): BridgeCryptoSession => {
  const sharedSecret = x25519.getSharedSecret(
    args.secretKey,
    base64UrlToBytes(args.peerPublicKey),
  );
  const salt = sha256(
    utf8ToBytes(`stella-mobile-bridge-session-v1:${args.sessionId}`),
  );
  const info = utf8ToBytes(
    [
      "stella-mobile-bridge-session-key-v1",
      args.sessionId,
      args.mobilePublicKey,
      args.desktopPublicKey,
    ].join("\n"),
  );
  return {
    sessionId: args.sessionId,
    key: hkdf(sha256, sharedSecret, salt, info, 32),
    txSeq: 0,
  };
};

const envelopeAad = (
  sessionId: string,
  direction: BridgeCryptoDirection,
  seq: number,
) =>
  utf8ToBytes(
    [BRIDGE_CRYPTO_PROTOCOL, sessionId, direction, String(seq)].join("\n"),
  );

export const isBridgeEncryptedEnvelope = (
  value: unknown,
): value is BridgeEncryptedEnvelope => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.alg === BRIDGE_CRYPTO_PROTOCOL &&
    typeof record.sid === "string" &&
    typeof record.seq === "number" &&
    typeof record.iv === "string" &&
    typeof record.ct === "string"
  );
};

export const encryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  payload: unknown,
): BridgeEncryptedEnvelope => {
  const seq = ++session.txSeq;
  const iv = new Uint8Array(randomBytes(12));
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const ciphertext = gcm(
    session.key,
    iv,
    envelopeAad(session.sessionId, direction, seq),
  ).encrypt(plaintext);
  return {
    v: 1,
    alg: BRIDGE_CRYPTO_PROTOCOL,
    sid: session.sessionId,
    seq,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(ciphertext),
  };
};

export const decryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  envelope: BridgeEncryptedEnvelope,
): unknown => {
  if (envelope.sid !== session.sessionId) {
    throw new Error("Bridge envelope session mismatch");
  }
  const plaintext = gcm(
    session.key,
    base64UrlToBytes(envelope.iv),
    envelopeAad(session.sessionId, direction, envelope.seq),
  ).decrypt(base64UrlToBytes(envelope.ct));
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
};
