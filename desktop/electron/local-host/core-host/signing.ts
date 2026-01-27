import { createHash, generateKeyPairSync, sign, verify } from "crypto";
import path from "path";
import { promises as fs } from "fs";
import type { StateStore } from "./state-store.js";

type SigningKeyRecord = {
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
};

const getKeyPath = (stateStore: StateStore) => path.join(stateStore.signingDir, "device-key.json");

const stableSort = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSort(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const next: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    next[key] = stableSort(record[key]);
  }
  return next;
};

export const stableStringify = (value: unknown) => {
  return JSON.stringify(stableSort(value));
};

export const hashCanonicalJson = (value: unknown) => {
  const canonical = stableStringify(value);
  const hash = createHash("sha256");
  hash.update(canonical, "utf-8");
  return {
    canonical,
    hashHex: hash.digest("hex"),
  };
};

const createKeys = (): SigningKeyRecord => {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    publicKeyPem,
    privateKeyPem,
    createdAt: Date.now(),
  };
};

export const ensureSigningKeys = async (stateStore: StateStore): Promise<SigningKeyRecord> => {
  const keyPath = getKeyPath(stateStore);
  try {
    const raw = await fs.readFile(keyPath, "utf-8");
    const parsed = JSON.parse(raw) as SigningKeyRecord;
    if (parsed?.privateKeyPem && parsed?.publicKeyPem) {
      return parsed;
    }
  } catch {
    // Fall through to create.
  }
  const created = createKeys();
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, JSON.stringify(created, null, 2), "utf-8");
  return created;
};

export const signHash = (privateKeyPem: string, hashHex: string) => {
  const signature = sign(null, Buffer.from(hashHex, "hex"), privateKeyPem);
  return signature.toString("base64");
};

export const verifySignature = (publicKeyPem: string, hashHex: string, signatureBase64: string) => {
  try {
    return verify(
      null,
      Buffer.from(hashHex, "hex"),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
};

