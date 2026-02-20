import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const LOCAL_SECRET_PREFIX = "stella-local-secret-v1";
const LOCAL_SECRET_AAD = "stella-local-secret";
const LOCAL_SECRET_KEY_PATH = path.join(os.homedir(), ".stella", "state", "secret_key_v1");

export const LOCAL_SECRET_KEY_VERSION = 2;

let cachedKey: Buffer | null = null;

const loadOrCreateKey = (): Buffer => {
  if (cachedKey) {
    return cachedKey;
  }

  fs.mkdirSync(path.dirname(LOCAL_SECRET_KEY_PATH), { recursive: true });
  if (!fs.existsSync(LOCAL_SECRET_KEY_PATH)) {
    const newKey = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(LOCAL_SECRET_KEY_PATH, newKey, { mode: 0o600 });
    cachedKey = newKey;
    return newKey;
  }

  const existingKey = fs.readFileSync(LOCAL_SECRET_KEY_PATH);
  if (existingKey.length !== KEY_BYTES) {
    throw new Error("Invalid local secret key length.");
  }
  cachedKey = existingKey;
  return existingKey;
};

export const encryptLocalSecret = (plaintext: string): string => {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(LOCAL_SECRET_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    LOCAL_SECRET_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
};

export const decryptLocalSecret = (value: string): string | null => {
  const [prefix, ivB64, authTagB64, ciphertextB64] = value.split(":");
  if (
    prefix !== LOCAL_SECRET_PREFIX ||
    !ivB64 ||
    !authTagB64 ||
    !ciphertextB64
  ) {
    return null;
  }

  try {
    const key = loadOrCreateKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAAD(Buffer.from(LOCAL_SECRET_AAD, "utf8"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64url")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
};
