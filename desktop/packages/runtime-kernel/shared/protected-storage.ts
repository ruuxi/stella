import { createRequire } from "module";

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
};

const require = createRequire(import.meta.url);
const PROTECTED_PREFIX = "stella-protected";

let safeStorageCache: SafeStorageLike | null | undefined;

const getSafeStorage = (): SafeStorageLike => {
  if (safeStorageCache) {
    return safeStorageCache;
  }
  if (safeStorageCache === null) {
    throw new Error("Protected storage is unavailable.");
  }
  if (!process.versions.electron) {
    safeStorageCache = null;
    throw new Error("Protected storage requires Electron runtime.");
  }

  const electronModule = require("electron") as { safeStorage?: SafeStorageLike } | string;
  const safeStorage =
    typeof electronModule === "string" ? undefined : electronModule.safeStorage;

  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    safeStorageCache = null;
    throw new Error("OS protected storage is unavailable.");
  }

  safeStorageCache = safeStorage;
  return safeStorage;
};

const prefixForScope = (scope: string) => `${PROTECTED_PREFIX}:${scope}:v1:`;

export const protectValue = (scope: string, plaintext: string): string => {
  const safeStorage = getSafeStorage();
  const encrypted = safeStorage.encryptString(plaintext);
  return `${prefixForScope(scope)}${encrypted.toString("base64url")}`;
};

export const unprotectValue = (scope: string, value: string): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const prefix = prefixForScope(scope);
  if (!value.startsWith(prefix)) {
    return null;
  }

  const encoded = value.slice(prefix.length);
  if (!encoded) {
    return null;
  }

  try {
    const safeStorage = getSafeStorage();
    return safeStorage.decryptString(Buffer.from(encoded, "base64url"));
  } catch {
    return null;
  }
};
