/**
 * Per-integration chat-connect preferences — currently just "the user
 * declined an in-chat connect offer". Persisted so agents never re-offer
 * an integration the user already said no to; the Store remains the
 * user-driven path to change their mind (enabling there clears the
 * decline via `clearConnectorDecline`).
 *
 * Single-writer discipline: the `stella-connect` CLI records declines
 * when its bridge round-trip resolves `declined`, and the enable paths
 * (Store IPC, `enable-native`, chat connect card) clear them. The
 * desktop reads it only indirectly through CLI output.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { getConnectorStateRoot } from "./state.js";

const PREFERENCES_FILE = "connect-preferences.json";

export type ConnectorDeclineEntry = {
  declinedAt: number;
  /** How many times an in-chat offer has been declined in total. */
  count: number;
};

type ConnectPreferencesFile = {
  version: 1;
  declined: Record<string, ConnectorDeclineEntry>;
};

const preferencesPath = (stellaAppDir: string) =>
  path.join(getConnectorStateRoot(stellaAppDir), PREFERENCES_FILE);

const readPreferences = async (
  stellaAppDir: string,
): Promise<ConnectPreferencesFile> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(preferencesPath(stellaAppDir), "utf-8"),
    ) as ConnectPreferencesFile;
    if (parsed?.version === 1 && parsed.declined) return parsed;
  } catch {
    // Missing/corrupt file is an empty preference set.
  }
  return { version: 1, declined: {} };
};

const writePreferences = async (
  stellaAppDir: string,
  preferences: ConnectPreferencesFile,
) => {
  const filePath = preferencesPath(stellaAppDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(preferences, null, 2)}\n`,
    "utf-8",
  );
};

export const getConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<ConnectorDeclineEntry | null> => {
  const preferences = await readPreferences(stellaAppDir);
  return preferences.declined[id] ?? null;
};

export const listConnectorDeclines = async (
  stellaAppDir: string,
): Promise<Record<string, ConnectorDeclineEntry>> => {
  const preferences = await readPreferences(stellaAppDir);
  return preferences.declined;
};

export const recordConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<ConnectorDeclineEntry> => {
  const preferences = await readPreferences(stellaAppDir);
  const entry: ConnectorDeclineEntry = {
    declinedAt: Date.now(),
    count: (preferences.declined[id]?.count ?? 0) + 1,
  };
  preferences.declined[id] = entry;
  await writePreferences(stellaAppDir, preferences);
  return entry;
};

export const clearConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<void> => {
  const preferences = await readPreferences(stellaAppDir);
  if (!(id in preferences.declined)) return;
  delete preferences.declined[id];
  await writePreferences(stellaAppDir, preferences);
};
