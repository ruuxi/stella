import fs from "fs";
import path from "path";
import { protectValue, unprotectValue } from "../shared/protected-storage.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../shared/private-fs.js";

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

const getStatePath = (stellaRoot: string) => path.join(stellaRoot, "state");

export const getLlmCredentialStorePath = (stellaRoot: string) =>
  path.join(getStatePath(stellaRoot), LLM_CREDENTIALS_FILE);

const readCredentialFile = (stellaRoot: string): StoredLlmCredentialFile => {
  const filePath = getLlmCredentialStorePath(stellaRoot);
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

const writeCredentialFile = (stellaRoot: string, payload: StoredLlmCredentialFile): void => {
  const filePath = getLlmCredentialStorePath(stellaRoot);
  ensurePrivateDirSync(path.dirname(filePath));
  writePrivateFileSync(filePath, JSON.stringify(payload, null, 2));
};

export const listLocalLlmCredentials = (
  stellaRoot: string,
): LocalLlmCredentialSummary[] => {
  const file = readCredentialFile(stellaRoot);
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
  stellaRoot: string,
  provider: string,
): string | null => {
  const normalizedProvider = normalizeProvider(provider);
  const file = readCredentialFile(stellaRoot);
  const record = file.credentials[normalizedProvider];
  if (!record) {
    return null;
  }

  return unprotectValue(credentialScope(normalizedProvider), record.valueProtected);
};

export const hasLocalLlmCredential = (
  stellaRoot: string,
  provider: string,
): boolean => {
  return Boolean(getLocalLlmCredential(stellaRoot, provider));
};

export const saveLocalLlmCredential = (
  stellaRoot: string,
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

  const file = readCredentialFile(stellaRoot);
  const now = Date.now();
  const existing = file.credentials[provider];
  file.credentials[provider] = {
    provider,
    label,
    valueProtected: protectValue(credentialScope(provider), plaintext),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeCredentialFile(stellaRoot, file);

  return {
    provider,
    label,
    status: "active",
    updatedAt: now,
  };
};

export const deleteLocalLlmCredential = (
  stellaRoot: string,
  provider: string,
): { removed: boolean } => {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { removed: false };
  }

  const file = readCredentialFile(stellaRoot);
  if (!file.credentials[normalizedProvider]) {
    return { removed: false };
  }

  delete file.credentials[normalizedProvider];
  writeCredentialFile(stellaRoot, file);
  return { removed: true };
};
