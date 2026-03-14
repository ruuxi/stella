/**
 * SpacetimeDB connection configuration.
 *
 * After deploying the SpacetimeDB module, generate bindings:
 *   spacetime generate {{spacetimedbModule}} --lang typescript --out-dir src/bindings --module-path ../../../../spacetimedb --yes
 *
 * Then import DbConnection and tables from the generated bindings.
 */

export const SPACETIMEDB_HOST =
  (import.meta as Record<string, Record<string, string>>).env
    ?.VITE_SPACETIMEDB_HOST ?? "wss://maincloud.spacetimedb.com";

export const SPACETIMEDB_MODULE =
  (import.meta as Record<string, Record<string, string>>).env
    ?.VITE_SPACETIMEDB_MODULE ?? "{{spacetimedbModule}}";

const SPACETIMEDB_TOKEN_KEY = "spacetimedb_token";
const DISPLAY_NAME_KEY = "stella_game_display_name";
const GAME_AUTH_TOKEN_KEY = "stella_game_auth_token";
const GAME_JOIN_CODE_KEY = "stella_game_join_code";
const GAME_SESSION_ID_KEY = "stella_game_session_id";

const writeSessionValue = (key: string, value: string | undefined): void => {
  try {
    if (value) {
      sessionStorage.setItem(key, value);
      return;
    }
    sessionStorage.removeItem(key);
  } catch {
    // sessionStorage may not be available
  }
};

export const getSavedToken = (): string | undefined => {
  try {
    return localStorage.getItem(SPACETIMEDB_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveToken = (token: string): void => {
  try {
    localStorage.setItem(SPACETIMEDB_TOKEN_KEY, token);
  } catch {
    // localStorage may not be available
  }
};

export type SavedLaunchAuth = {
  gameToken: string;
  displayName?: string;
  joinCode?: string;
  spacetimeSessionId?: string;
};

export const getSavedGameAuthToken = (): string | undefined => {
  try {
    return sessionStorage.getItem(GAME_AUTH_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveGameAuthToken = (token: string): void => {
  try {
    sessionStorage.setItem(GAME_AUTH_TOKEN_KEY, token);
  } catch {
    // sessionStorage may not be available
  }
};

export const getSavedDisplayName = (): string | undefined => {
  try {
    return sessionStorage.getItem(DISPLAY_NAME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveDisplayName = (displayName: string): void => {
  try {
    sessionStorage.setItem(DISPLAY_NAME_KEY, displayName);
  } catch {
    // sessionStorage may not be available
  }
};

export const saveJoinCode = (joinCode: string): void => {
  try {
    sessionStorage.setItem(GAME_JOIN_CODE_KEY, joinCode);
  } catch {
    // sessionStorage may not be available
  }
};

export const getSavedJoinCode = (): string | undefined => {
  try {
    return sessionStorage.getItem(GAME_JOIN_CODE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveSessionId = (sessionId: string): void => {
  try {
    sessionStorage.setItem(GAME_SESSION_ID_KEY, sessionId);
  } catch {
    // sessionStorage may not be available
  }
};

export const getSavedSessionId = (): string | undefined => {
  try {
    return sessionStorage.getItem(GAME_SESSION_ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveLaunchAuth = (auth: SavedLaunchAuth): void => {
  saveGameAuthToken(auth.gameToken);
  writeSessionValue(DISPLAY_NAME_KEY, auth.displayName);
  writeSessionValue(GAME_JOIN_CODE_KEY, auth.joinCode);
  writeSessionValue(GAME_SESSION_ID_KEY, auth.spacetimeSessionId);
};

export const getSavedLaunchAuth = (): SavedLaunchAuth | null => {
  const gameToken = getSavedGameAuthToken();
  if (!gameToken) {
    return null;
  }

  const displayName = getSavedDisplayName();
  const joinCode = getSavedJoinCode();
  const spacetimeSessionId = getSavedSessionId();

  return {
    gameToken,
    ...(displayName ? { displayName } : {}),
    ...(joinCode ? { joinCode } : {}),
    ...(spacetimeSessionId ? { spacetimeSessionId } : {}),
  };
};

export const clearLaunchAuth = (): void => {
  try {
    sessionStorage.removeItem(GAME_AUTH_TOKEN_KEY);
    sessionStorage.removeItem(DISPLAY_NAME_KEY);
    sessionStorage.removeItem(GAME_JOIN_CODE_KEY);
    sessionStorage.removeItem(GAME_SESSION_ID_KEY);
  } catch {
    // sessionStorage may not be available
  }
};
