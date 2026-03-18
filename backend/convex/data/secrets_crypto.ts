export type EncryptedSecretPayload = {
  keyVersion: number;
  dataNonce: string;
  dataCiphertext: string;
  keyNonce: string;
  keyCiphertext: string;
};

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_MAP_JSON_ENV = "STELLA_SECRETS_MASTER_KEYS_JSON";

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const parseKeyVersion = (raw: string, context: string): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${context} has invalid key version "${raw}"`);
  }
  return Math.floor(parsed);
};

const decodeMasterKey = (raw: string, context: string): Uint8Array => {
  const bytes = base64ToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`${context} must be 32 bytes (base64)`);
  }
  return bytes;
};

type MasterKeyRing = {
  activeVersion: number;
  entries: Map<number, Uint8Array>;
};

const parseMasterKeysFromJsonEnv = (raw: string): Map<number, Uint8Array> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${KEY_MAP_JSON_ENV} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${KEY_MAP_JSON_ENV} must be a JSON object of {"<version>":"<base64Key>"}`);
  }

  const entries = new Map<number, Uint8Array>();
  for (const [rawVersion, rawKey] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
      throw new Error(`${KEY_MAP_JSON_ENV} entry "${rawVersion}" must be a non-empty base64 string`);
    }
    const version = parseKeyVersion(rawVersion, `${KEY_MAP_JSON_ENV} entry`);
    entries.set(version, decodeMasterKey(rawKey, `${KEY_MAP_JSON_ENV} entry "${rawVersion}"`));
  }
  return entries;
};

const parseActiveKeyVersion = (entries: Map<number, Uint8Array>): number => {
  const raw = process.env.STELLA_SECRETS_MASTER_KEY_VERSION;
  if (raw != null && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("STELLA_SECRETS_MASTER_KEY_VERSION must be a positive integer");
    }
    return Math.floor(parsed);
  }

  const versions = [...entries.keys()].sort((a, b) => b - a);
  if (versions.length === 0) {
    return 1;
  }
  return versions[0];
};

const getMasterKeyRing = (): MasterKeyRing => {
  const rawJson = process.env[KEY_MAP_JSON_ENV];
  if (!rawJson || rawJson.trim().length === 0) {
    throw new Error(`${KEY_MAP_JSON_ENV} is required`);
  }
  const entries = parseMasterKeysFromJsonEnv(rawJson);

  if (entries.size === 0) {
    throw new Error(`${KEY_MAP_JSON_ENV} must contain at least one key`);
  }

  const activeVersion = parseActiveKeyVersion(entries);
  if (!entries.has(activeVersion)) {
    throw new Error(
      `Active secret key version ${activeVersion} is missing from configured master keys.`,
    );
  }

  return {
    activeVersion,
    entries,
  };
};

const importAesKey = (bytes: Uint8Array) => {
  const keyData = Uint8Array.from(bytes).buffer;
  return crypto.subtle.importKey("raw", keyData, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};

const randomNonce = () => crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

const encryptWithKey = async (key: CryptoKey, plaintext: Uint8Array) => {
  const nonce = randomNonce();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

const decryptWithKey = async (
  key: CryptoKey,
  payload: { nonce: string; ciphertext: string },
) => {
  const nonce = base64ToBytes(payload.nonce);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  return new Uint8Array(plaintext);
};

const isEncryptedSecretPayload = (
  value: unknown,
): value is EncryptedSecretPayload => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.keyVersion === "number" &&
    typeof record.dataNonce === "string" &&
    typeof record.dataCiphertext === "string" &&
    typeof record.keyNonce === "string" &&
    typeof record.keyCiphertext === "string"
  );
};

const parseEncryptedSecretPayload = (
  serialized: string,
): EncryptedSecretPayload => {
  const payloadRaw = JSON.parse(serialized) as unknown;
  if (!isEncryptedSecretPayload(payloadRaw)) {
    throw new Error("Invalid encrypted secret payload");
  }
  return payloadRaw as EncryptedSecretPayload;
};

const decryptDataKey = async (
  payload: EncryptedSecretPayload,
  keyRing: MasterKeyRing,
): Promise<Uint8Array> => {
  const preferred = keyRing.entries.get(payload.keyVersion);
  if (!preferred) {
    throw new Error(
      `Missing master key for payload key version ${payload.keyVersion}.`,
    );
  }
  const masterKey = await importAesKey(preferred);
  return await decryptWithKey(masterKey, {
    nonce: payload.keyNonce,
    ciphertext: payload.keyCiphertext,
  });
};

export const encryptSecret = async (plaintext: string): Promise<EncryptedSecretPayload> => {
  const keyRing = getMasterKeyRing();
  const keyVersion = keyRing.activeVersion;
  const activeMasterKeyBytes = keyRing.entries.get(keyVersion);
  if (!activeMasterKeyBytes) {
    throw new Error(`Missing active master key for version ${keyVersion}`);
  }
  const masterKey = await importAesKey(activeMasterKeyBytes);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dataKey = await importAesKey(dataKeyBytes);

  const data = await encryptWithKey(dataKey, encoder.encode(plaintext));
  const wrappedKey = await encryptWithKey(masterKey, dataKeyBytes);

  return {
    keyVersion,
    dataNonce: data.nonce,
    dataCiphertext: data.ciphertext,
    keyNonce: wrappedKey.nonce,
    keyCiphertext: wrappedKey.ciphertext,
  };
};

export const decryptSecret = async (serialized: string): Promise<string> => {
  const keyRing = getMasterKeyRing();
  const payload = parseEncryptedSecretPayload(serialized);
  const dataKeyBytes = await decryptDataKey(payload, keyRing);
  const dataKey = await importAesKey(dataKeyBytes);

  const plaintextBytes = await decryptWithKey(dataKey, {
    nonce: payload.dataNonce,
    ciphertext: payload.dataCiphertext,
  });

  return decoder.decode(plaintextBytes);
};

export const isEncryptedSecretSerialized = (serialized: string): boolean => {
  if (serialized.trim().length === 0) {
    return false;
  }
  try {
    return isEncryptedSecretPayload(JSON.parse(serialized));
  } catch {
    return false;
  }
};

export const decryptSecretIfNeeded = async (value: string): Promise<string> => {
  if (!isEncryptedSecretSerialized(value)) {
    return value;
  }
  return await decryptSecret(value);
};

export const getActiveSecretKeyVersion = (): number => getMasterKeyRing().activeVersion;

export const rotateSecretToActiveKey = async (
  serialized: string,
): Promise<{ serialized: string; keyVersion: number; changed: boolean }> => {
  const activeVersion = getActiveSecretKeyVersion();
  if (!isEncryptedSecretSerialized(serialized)) {
    throw new Error("Cannot rotate non-encrypted secret payload.");
  }

  const payload = parseEncryptedSecretPayload(serialized);
  if (payload.keyVersion === activeVersion) {
    return {
      serialized,
      keyVersion: activeVersion,
      changed: false,
    };
  }

  const plaintext = await decryptSecret(serialized);
  const encrypted = await encryptSecret(plaintext);
  return {
    serialized: JSON.stringify(encrypted),
    keyVersion: encrypted.keyVersion,
    changed: true,
  };
};
