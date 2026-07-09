import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "crypto";
import { deflateRawSync, inflateRawSync } from "zlib";

export const BRIDGE_CRYPTO_PROTOCOL = "x25519-hkdf-sha256-aes-256-gcm-v1";

/**
 * Optional bridge features negotiated above the base protocol. The phone
 * advertises its own set in the `X-Stella-Bridge-Features` header; the desktop
 * advertises its set in the `mobile:hello` response. Every feature is additive
 * — either peer missing one simply keeps the legacy path.
 */
export const BRIDGE_FEATURE_HELLO = "hello-v1";
export const BRIDGE_FEATURE_DEFLATE = "envelope-deflate";
export const BRIDGE_FEATURE_BINARY_FILE = "binary-file-lane";
export const BRIDGE_FEATURE_BINARY_UPLOAD = "binary-upload";
export const BRIDGE_FEATURE_LOCAL_CHAT_PUSH = "localchat-push";

/**
 * JSON envelopes are control-plane/chat data, never file bodies. Keep
 * decompression bounded so an authenticated-but-corrupt peer cannot turn a
 * small deflate frame into an unbounded main-process allocation. Binary files
 * continue to use the separately bounded binary lane.
 */
export const MAX_BRIDGE_ENVELOPE_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export type BridgeCryptoDirection = "m2d" | "d2m";

export type BridgeEncryptedEnvelope = {
  v: 1;
  alg: typeof BRIDGE_CRYPTO_PROTOCOL;
  sid: string;
  seq: number;
  iv: string;
  ct: string;
  /** 1 = plaintext was raw-deflated before encryption (feature-gated). */
  z?: 1;
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

/**
 * Sliding-window replay guard for received envelope sequence numbers.
 *
 * Strict monotonic rejection would break legitimate traffic: concurrent HTTP
 * requests are encrypted in order but can complete/arrive out of order. The
 * standard fix (as in DTLS/IPsec) is a window — accept any unseen seq newer
 * than `maxSeen - windowSize`, reject duplicates and anything older.
 */
export type BridgeReplayGuard = {
  /** Throws on a replayed or too-old sequence number; records fresh ones. */
  check: (seq: number) => void;
};

export const BRIDGE_REPLAY_WINDOW = 128;

export const createBridgeReplayGuard = (
  windowSize = BRIDGE_REPLAY_WINDOW,
): BridgeReplayGuard => {
  let maxSeen = 0;
  const seen = new Set<number>();
  return {
    check: (seq: number) => {
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new Error("Bridge envelope replay rejected (invalid seq)");
      }
      if (seq <= maxSeen - windowSize) {
        throw new Error("Bridge envelope replay rejected (stale seq)");
      }
      if (seen.has(seq)) {
        throw new Error("Bridge envelope replay rejected (duplicate seq)");
      }
      seen.add(seq);
      if (seq > maxSeen) {
        maxSeen = seq;
        for (const value of seen) {
          if (value <= maxSeen - windowSize) {
            seen.delete(value);
          }
        }
      }
    },
  };
};

export const encryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  payload: unknown,
  options?: {
    /**
     * Deflate the JSON plaintext before encryption. Only pass true when the
     * peer advertised BRIDGE_FEATURE_DEFLATE — an old peer would decrypt to
     * binary garbage. Skipped automatically when it doesn't shrink.
     */
    compress?: boolean;
  },
): BridgeEncryptedEnvelope => {
  const seq = ++session.txSeq;
  const iv = new Uint8Array(randomBytes(12));
  const json = utf8ToBytes(JSON.stringify(payload));
  let plaintext = json;
  let compressed = false;
  if (options?.compress) {
    const deflated = new Uint8Array(deflateRawSync(json));
    if (deflated.length < json.length) {
      plaintext = deflated;
      compressed = true;
    }
  }
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
    ...(compressed ? { z: 1 as const } : {}),
  };
};

export const decryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  envelope: BridgeEncryptedEnvelope,
  replayGuard?: BridgeReplayGuard,
): unknown => {
  if (envelope.sid !== session.sessionId) {
    throw new Error("Bridge envelope session mismatch");
  }
  const plaintext = gcm(
    session.key,
    base64UrlToBytes(envelope.iv),
    envelopeAad(session.sessionId, direction, envelope.seq),
  ).decrypt(base64UrlToBytes(envelope.ct));
  // Only trust the compression flag after authenticated decryption succeeded.
  replayGuard?.check(envelope.seq);
  const json =
    envelope.z === 1
      ? new Uint8Array(
          inflateRawSync(plaintext, {
            maxOutputLength: MAX_BRIDGE_ENVELOPE_PLAINTEXT_BYTES,
          }),
        )
      : plaintext;
  return JSON.parse(new TextDecoder().decode(json)) as unknown;
};

// ── Binary lane ─────────────────────────────────────────────────────────
// Raw file bytes are encrypted directly (no JSON, no base64) and shipped as
// an HTTP body with the seq/iv riding headers. AAD binds the same protocol
// string, session, direction and seq as JSON envelopes, plus a `bin` marker
// so a binary ciphertext can never be replayed into the JSON lane or vice
// versa. Deliberately NOT compressed: the payloads are images/PDFs/media that
// are already entropy-coded.

const binaryAad = (
  sessionId: string,
  direction: BridgeCryptoDirection,
  seq: number,
) =>
  utf8ToBytes(
    [BRIDGE_CRYPTO_PROTOCOL, sessionId, direction, "bin", String(seq)].join(
      "\n",
    ),
  );

export type BridgeBinaryFrame = {
  seq: number;
  /** base64url, 12 bytes. */
  iv: string;
  /** Raw ciphertext (plaintext length + 16-byte GCM tag). */
  ciphertext: Uint8Array;
};

export const encryptBridgeBytes = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  bytes: Uint8Array,
): BridgeBinaryFrame => {
  const seq = ++session.txSeq;
  const iv = new Uint8Array(randomBytes(12));
  const ciphertext = gcm(
    session.key,
    iv,
    binaryAad(session.sessionId, direction, seq),
  ).encrypt(bytes);
  return { seq, iv: bytesToBase64Url(iv), ciphertext };
};

export const decryptBridgeBytes = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  frame: BridgeBinaryFrame,
  replayGuard?: BridgeReplayGuard,
): Uint8Array => {
  const plaintext = gcm(
    session.key,
    base64UrlToBytes(frame.iv),
    binaryAad(session.sessionId, direction, frame.seq),
  ).decrypt(frame.ciphertext);
  replayGuard?.check(frame.seq);
  return plaintext;
};
