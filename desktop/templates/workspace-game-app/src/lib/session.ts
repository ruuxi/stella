/**
 * Session and join code utilities.
 * Reads session info from URL parameters for the join flow and the
 * Stella-hosted launch handoff.
 */

import {
  clearLaunchAuth,
  getSavedLaunchAuth,
  getSavedDisplayName,
  getSavedJoinCode,
  getSavedSessionId,
  saveLaunchAuth,
  saveSessionId,
  saveDisplayName,
} from "./connection";

export const GAME_AUTH_MESSAGE_TYPE = "stella:game-auth";

export type HostedGameAuthMessage = {
  type: typeof GAME_AUTH_MESSAGE_TYPE;
  gameToken: string;
  displayName?: string;
  joinCode?: string;
  spacetimeSessionId?: string;
};

export const getSessionFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  if (params.has("session")) {
    return params.get("session");
  }
  if (params.has("code")) {
    return null;
  }
  return params.get("session") ?? getSavedSessionId() ?? null;
};

export const getJoinCodeFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  return params.get("code") ?? getSavedJoinCode() ?? null;
};

export const getLaunchGameToken = (): string | undefined =>
  getSavedLaunchAuth()?.gameToken;

export const getLaunchDisplayName = (): string | undefined =>
  getSavedDisplayName();

export type DecodedHostedGameToken = {
  gameId?: string;
  userId?: string;
};

export const saveLaunchDisplayName = (displayName: string): void => {
  saveDisplayName(displayName);
};

export const saveActiveSessionId = (sessionId: bigint): void => {
  saveSessionId(sessionId.toString());
};

export const saveHostedLaunchAuth = (message: HostedGameAuthMessage): void => {
  saveLaunchAuth({
    gameToken: message.gameToken,
    ...(message.displayName ? { displayName: message.displayName } : {}),
    ...(message.joinCode ? { joinCode: message.joinCode } : {}),
    ...(message.spacetimeSessionId
      ? { spacetimeSessionId: message.spacetimeSessionId }
      : {}),
  });
};

export const clearHostedLaunchAuth = (): void => {
  clearLaunchAuth();
};

export const decodeHostedGameToken = (
  token: string,
): DecodedHostedGameToken | null => {
  const [payload] = token.split(".");
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    const padded =
      remainder === 0
        ? normalized
        : remainder === 2
          ? `${normalized}==`
          : remainder === 3
            ? `${normalized}=`
            : null;

    if (!padded) {
      return null;
    }

    const decoded = JSON.parse(window.atob(padded)) as Record<string, unknown>;
    return {
      ...(typeof decoded.gameId === "string" ? { gameId: decoded.gameId } : {}),
      ...(typeof decoded.sub === "string" ? { userId: decoded.sub } : {}),
    };
  } catch {
    return null;
  }
};

export const isHostedGameAuthMessage = (
  value: unknown,
): value is HostedGameAuthMessage => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === GAME_AUTH_MESSAGE_TYPE &&
    typeof record.gameToken === "string" &&
    record.gameToken.trim().length > 0
  );
};

export const buildJoinUrl = (baseUrl: string, joinCode: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/games/join?code=${encodeURIComponent(joinCode)}`;
