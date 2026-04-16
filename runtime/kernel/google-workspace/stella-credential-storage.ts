/**
 * Plain JSON OAuth token storage under the Stella Google Workspace data directory.
 * Replaces the upstream encrypted/keychain storage while preserving the same
 * Google `Credentials` shape used by google-auth-library.
 *
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Credentials } from "google-auth-library";
import { getProjectRoot } from "./paths.js";

const FILE_NAME = "oauth-credentials.json";

function credentialsPath(): string {
  return path.join(getProjectRoot(), FILE_NAME);
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const root = getProjectRoot();
  if (!root) {
    throw new Error("Google Workspace project root not set.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    credentialsPath(),
    `${JSON.stringify(credentials, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function clearCredentials(): Promise<void> {
  try {
    await unlink(credentialsPath());
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

export function hasStoredCredentialsFile(): boolean {
  try {
    return existsSync(credentialsPath());
  } catch {
    return false;
  }
}
