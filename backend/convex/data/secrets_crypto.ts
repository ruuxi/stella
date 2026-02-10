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

const getMasterKeyBytes = () => {
  const raw = process.env.STELLA_SECRETS_MASTER_KEY ?? "";
  if (!raw) {
    throw new Error("STELLA_SECRETS_MASTER_KEY is not set");
  }
  const bytes = base64ToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error("STELLA_SECRETS_MASTER_KEY must be 32 bytes (base64)");
  }
  return bytes;
};

const getKeyVersion = () => {
  const raw = process.env.STELLA_SECRETS_MASTER_KEY_VERSION ?? "1";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
};

const importAesKey = (bytes: Uint8Array) =>
  crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);

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

const isEncryptedSecretPayload = (value: unknown): value is EncryptedSecretPayload => {
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

export const isEncryptedSecretSerialized = (value: string) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isEncryptedSecretPayload(parsed);
  } catch {
    return false;
  }
};

export const encryptSecret = async (plaintext: string): Promise<EncryptedSecretPayload> => {
  const masterKeyBytes = getMasterKeyBytes();
  const masterKey = await importAesKey(masterKeyBytes);
  const keyVersion = getKeyVersion();
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
  const masterKeyBytes = getMasterKeyBytes();
  const masterKey = await importAesKey(masterKeyBytes);
  const payloadRaw = JSON.parse(serialized) as unknown;
  if (!isEncryptedSecretPayload(payloadRaw)) {
    throw new Error("Invalid encrypted secret payload");
  }
  const payload = payloadRaw as EncryptedSecretPayload;

  const dataKeyBytes = await decryptWithKey(masterKey, {
    nonce: payload.keyNonce,
    ciphertext: payload.keyCiphertext,
  });
  const dataKey = await importAesKey(dataKeyBytes);

  const plaintextBytes = await decryptWithKey(dataKey, {
    nonce: payload.dataNonce,
    ciphertext: payload.dataCiphertext,
  });

  return decoder.decode(plaintextBytes);
};

export const decryptSecretIfNeeded = async (serializedOrPlaintext: string): Promise<string> => {
  if (!isEncryptedSecretSerialized(serializedOrPlaintext)) {
    return serializedOrPlaintext;
  }
  return await decryptSecret(serializedOrPlaintext);
};
