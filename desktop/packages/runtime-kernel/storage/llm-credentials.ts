import fs from "fs";
import path from "path";
import { protectValue, unprotectValue } from "./protected-storage.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../home/private-fs.js";

const LLM_CREDENTIALS_FILE = "llm_credentials.json";
const LLM_CREDENTIAL_SCOPE_PREFIX = "llm-credential";

type StoredLlmCredentialRecord = {
  provider: string;
  label: string;
  valueProtected: string;
  createdAt: number;
  updatedAt: number;
};

type StoredLlmCredentialFile = {
  version: 1;
  credentials: Record<string, StoredLlmCredentialRecord>;
};

export type LocalLlmCredentialSummary = {
  provider: string;
  label: string;
  status: "active";
  updatedAt: number;
};

const normalizeProvider = (provider: string) => provider.trim().toLowerCase();

const credentialScope = (provider: string) =>
  `${LLM_CREDENTIAL_SCOPE_PREFIX}:${normalizeProvider(provider)}`;

const getStatePath = (stellaHomePath: string) => path.join(stellaHomePath, "state");

export const getLlmCredentialStorePath = (stellaHomePath: string) =>
  path.join(getStatePath(stellaHomePath), LLM_CREDENTIALS_FILE);

const readCredentialFile = (stellaHomePath: string): StoredLlmCredentialFile => {
  const filePath = getLlmCredentialStorePath(stellaHomePath);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredLlmCredentialFile;
    if (parsed && parsed.version === 1 && parsed.credentials && typeof parsed.credentials === "object") {
      return parsed;
    }
  } catch {
    // Fall through to empty store.
  }

  return {
    version: 1,
    credentials: {},
  };
};

const writeCredentialFile = (stellaHomePath: string, payload: StoredLlmCredentialFile): void => {
  const filePath = getLlmCredentialStorePath(stellaHomePath);
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(payload, null, 2));
};

export const listLocalLlmCredentials = (
  stellaHomePath: string,
): LocalLlmCredentialSummary[] => {
  const file = readCredentialFile(stellaHomePath);
  return Object.values(file.credentials)
    .map((record) => ({
      provider: record.provider,
      label: record.label,
      status: "active" as const,
      updatedAt: record.updatedAt,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

export const getLocalLlmCredential = (
  stellaHomePath: string,
  provider: string,
): string | null => {
  const normalizedProvider = normalizeProvider(provider);
  const file = readCredentialFile(stellaHomePath);
  const record = file.credentials[normalizedProvider];
  if (!record) {
    return null;
  }

  return unprotectValue(credentialScope(normalizedProvider), record.valueProtected);
};

export const hasLocalLlmCredential = (
  stellaHomePath: string,
  provider: string,
): boolean => {
  return Boolean(getLocalLlmCredential(stellaHomePath, provider));
};

export const saveLocalLlmCredential = (
  stellaHomePath: string,
  payload: { provider: string; label: string; plaintext: string },
): LocalLlmCredentialSummary => {
  const provider = normalizeProvider(payload.provider);
  const label = payload.label.trim() || provider;
  const plaintext = payload.plaintext.trim();
  if (!provider) {
    throw new Error("Missing provider.");
  }
  if (!plaintext) {
    throw new Error("Missing API key.");
  }

  const file = readCredentialFile(stellaHomePath);
  const now = Date.now();
  const existing = file.credentials[provider];
  file.credentials[provider] = {
    provider,
    label,
    valueProtected: protectValue(credentialScope(provider), plaintext),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeCredentialFile(stellaHomePath, file);

  return {
    provider,
    label,
    status: "active",
    updatedAt: now,
  };
};

export const deleteLocalLlmCredential = (
  stellaHomePath: string,
  provider: string,
): { removed: boolean } => {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { removed: false };
  }

  const file = readCredentialFile(stellaHomePath);
  if (!file.credentials[normalizedProvider]) {
    return { removed: false };
  }

  delete file.credentials[normalizedProvider];
  writeCredentialFile(stellaHomePath, file);
  return { removed: true };
};
