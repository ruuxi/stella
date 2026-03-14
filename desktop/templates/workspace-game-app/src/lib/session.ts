/**
 * Session and join code utilities.
 * Reads session info from URL parameters for the join flow.
 */

import {
  getSavedConvexToken,
  getSavedDisplayName,
  saveConvexToken,
  saveDisplayName,
} from "./connection";

const CONVEX_TOKEN_QUERY_KEYS = ["token", "convexToken"];
const DISPLAY_NAME_QUERY_KEY = "name";

export const getSessionFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
};

export const getJoinCodeFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  return params.get("code");
};

export const bootstrapLaunchStateFromUrl = (): void => {
  const params = new URLSearchParams(window.location.search);
  for (const key of CONVEX_TOKEN_QUERY_KEYS) {
    const token = params.get(key)?.trim();
    if (token) {
      saveConvexToken(token);
      break;
    }
  }

  const displayName = params.get(DISPLAY_NAME_QUERY_KEY)?.trim();
  if (displayName) {
    saveDisplayName(displayName);
  }
};

export const getLaunchConvexToken = (): string | undefined =>
  getSavedConvexToken();

export const getLaunchDisplayName = (): string | undefined =>
  getSavedDisplayName();

export const saveLaunchDisplayName = (displayName: string): void => {
  saveDisplayName(displayName);
};

export const buildJoinUrl = (baseUrl: string, joinCode: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/games/join?code=${encodeURIComponent(joinCode)}`;
